// /api/admin-login.js — Signed, expiring admin token (timing-safe compare)
import {
  corsHeaders,
  getClientIP,
  enforceHttps,
  cookieHeader,
  jsonResponse,
  checkRateLimit,
  recordRateLimit,
  parseJSONSafely,
  createAdminToken
} from './_utils.js';

const ADMIN_TTL_SECONDS = 8 * 60 * 60; // 8 hours

// Constant-time string comparison.
// Both strings must be the same length; we compare by XOR of char codes.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
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

    if (!timingSafeEqual(password, adminPass)) {
      await recordRateLimit(db, clientIP, 'admin_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    // Signed, expiring token — cannot be replayed after 8 hours
    const token = await createAdminToken({ type: 'admin', role: 'owner' }, env);

    console.log(`Admin login successful (IP: ${clientIP})`);

    return new Response(JSON.stringify({
      success: true,
      token: token,
      expiresIn: ADMIN_TTL_SECONDS,
      message: 'Login successful'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieHeader('admin_token', token, ADMIN_TTL_SECONDS),
        ...corsHeaders(request)
      }
    });
  } catch (e) {
    console.error('Admin login error:', e.message);
    return jsonResponse({ error: 'Login failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
