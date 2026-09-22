// /api/admin-login.js — Admin login.
//
// [THIS REVISION — 17 Sept 2026]
// When an admin logs in, the `guest_token` cookie is now explicitly
// cleared in the response. Mirror of the guest-login fix: one browser,
// one identity. Prevents the same class of session-collision leak in
// the other direction (a guest cookie leaking into an admin page).
import {
  corsHeaders,
  getClientIP,
  enforceHttps,
  cookieHeader,
  clearCookieHeader,
  jsonResponse,
  checkRateLimit,
  recordRateLimit,
  parseJSONSafely,
  createAdminToken
} from './_utils.js';

const ADMIN_TTL_SECONDS = 8 * 60 * 60; // 8 hours

async function sha256Bytes(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

function constantTimeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const rateOk = await checkRateLimit(db, clientIP, 'admin_login', 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }

    const { password } = await parseJSONSafely(request);

    if (!password || typeof password !== 'string') {
      await recordRateLimit(db, clientIP, 'admin_login');
      return jsonResponse({ error: 'Invalid credentials' }, 400, request);
    }

    const adminPass = env.ADMIN_PASSWORD;
    if (!adminPass) {
      console.error('ADMIN_PASSWORD environment variable is not set!');
      return jsonResponse({ error: 'Server configuration error. Please contact support.' }, 500, request);
    }

    const [inputDigest, expectedDigest] = await Promise.all([
      sha256Bytes(password),
      sha256Bytes(adminPass)
    ]);

    if (!constantTimeEqualBytes(inputDigest, expectedDigest)) {
      await recordRateLimit(db, clientIP, 'admin_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const token = await createAdminToken({ type: 'admin', role: 'owner' }, env);

    console.log(`Admin login successful (IP: ${clientIP})`);

    // Build headers with TWO Set-Cookie directives:
    //   1. Set the new admin_token.
    //   2. Clear the guest_token so this browser is unambiguously
    //      an admin session, not a guest session.
    const headers = new Headers(corsHeaders(request, env));
    headers.append('Set-Cookie', cookieHeader('admin_token', token, ADMIN_TTL_SECONDS));
    headers.append('Set-Cookie', clearCookieHeader('guest_token'));

    return new Response(JSON.stringify({
      success: true,
      token: token,
      expiresIn: ADMIN_TTL_SECONDS,
      message: 'Login successful'
    }), {
      status: 200,
      headers
    });
  } catch (e) {
    console.error('Admin login error:', e.message);
    return jsonResponse({ error: 'Login failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}
