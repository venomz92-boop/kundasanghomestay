// /api/admin-login.js — Admin login.
//
// [REVISION — 22 Sept 2026 — Phase 3 security fixes]
// - Token is NO LONGER returned in the JSON response body. Returning it
//   defeated the whole point of an HttpOnly cookie (any XSS on the admin
//   page could just read the token out of the response/JS variable).
// - Admin cookie is now HttpOnly + Secure + SameSite=Strict (was Lax).
//   Strict means the admin cookie is not sent on top-level navigations
//   from another site — correct for an admin panel.
// - Admin token role is now 'admin' (was 'owner'), so admin-only checks
//   actually match.
// - Added a GLOBAL rate limit in addition to the per-IP one, so a
//   distributed brute force across many IPs is also slowed.
// - Cache-Control: no-store on responses.
// - Success log no longer includes the client IP.
// - The `guest_token` cookie is still cleared on admin login so one browser
//   is unambiguously one identity.
import {
  corsHeaders,
  getClientIP,
  enforceHttps,
  clearCookieHeader,
  jsonResponse,
  checkRateLimit,
  recordRateLimit,
  parseJSONSafely,
  createAdminToken
} from './_utils.js';

const ADMIN_TTL_SECONDS = 8 * 60 * 60; // 8 hours

// Per-IP limits
const IP_LIMIT = 5;
const IP_WINDOW_SECONDS = 15 * 60;
// Global limit — slows distributed brute force across many IPs.
// Identifier below is a fixed sentinel; it is NOT an IP address.
const GLOBAL_KEY = '__admin_login_global__';
const GLOBAL_LIMIT = 20;
const GLOBAL_WINDOW_SECONDS = 15 * 60;

// Local cookie builder for the admin cookie only. We do this here so the
// admin cookie is guaranteed HttpOnly + Secure + SameSite=Strict regardless
// of whatever defaults _utils.cookieHeader uses for guest/owner cookies.
function adminCookieHeader(name, value, maxAgeSeconds) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ].join('; ');
}

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

    // Per-IP rate limit (fails closed by default per _utils.js).
    const ipOk = await checkRateLimit(db, clientIP, 'admin_login', IP_LIMIT, IP_WINDOW_SECONDS);
    if (!ipOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }

    // Global rate limit (also fails closed).
    const globalOk = await checkRateLimit(db, GLOBAL_KEY, 'admin_login', GLOBAL_LIMIT, GLOBAL_WINDOW_SECONDS);
    if (!globalOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }

    const { password } = await parseJSONSafely(request);

    if (!password || typeof password !== 'string') {
      await recordRateLimit(db, clientIP, 'admin_login');
      await recordRateLimit(db, GLOBAL_KEY, 'admin_login');
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
      await recordRateLimit(db, GLOBAL_KEY, 'admin_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    // Role must be 'admin' — downstream admin-only checks depend on this.
    const token = await createAdminToken({ type: 'admin', role: 'admin' }, env);

    console.log('Admin login successful');

    // Success response:
    //   1. Set the admin_token cookie (HttpOnly, Secure, SameSite=Strict).
    //   2. Clear the guest_token so this browser is unambiguously an
    //      admin session, not a guest session.
    //   3. Do NOT include the token in the JSON body.
    const headers = new Headers(corsHeaders(request));
    headers.set('Cache-Control', 'no-store');
    headers.append('Set-Cookie', adminCookieHeader('admin_token', token, ADMIN_TTL_SECONDS));
    headers.append('Set-Cookie', clearCookieHeader('guest_token'));

    return new Response(JSON.stringify({
      success: true,
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
  return new Response(null, { headers: corsHeaders(request) });
}
