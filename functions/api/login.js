// /api/login.js — Guest login.
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - generateCSRFToken now receives the guest's sessionVersion. Without
//   this the CSRF token was issued with sv=0 but the session was at
//   sv=N, so every guest POST returned 403 CSRF_INVALID once the
//   session-bound CSRF change shipped. (Regression introduced by the
//   Phase 3 CSRF hardening; caught during review.)
// - passwordVersion default uses ?? instead of || so a legitimate
//   version of 0 is preserved.
// - Added a global login rate limit in parallel with the per-IP one,
//   so a distributed brute force across many IPs is also slowed.
// - Success response is now Cache-Control: no-store.
// - Error log no longer includes the stack trace.
//
// The guest login still clears admin_token (session-collision fix from
// 17 Sept 2026 — see comment below), but deliberately does NOT clear
// owner_token. Guest + owner coexistence is supported by
// /api/_middleware.js which tries both sessions when validating CSRF.
import {
  corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword,
  createSignedToken, generateCSRFToken, cookieHeader, clearCookieHeader,
  jsonResponse, checkRateLimit, recordRateLimit, parseJSONSafely
} from './_utils.js';

const GUEST_TTL_MS      = 30 * 24 * 60 * 60 * 1000;  // 30 days
const GUEST_TTL_SECONDS = GUEST_TTL_MS / 1000;

// Per-IP limits
const IP_LIMIT = 5;
const IP_WINDOW_SECONDS = 15 * 60;
// Global limit — fixed sentinel, not an IP address.
const GLOBAL_KEY = '__guest_login_global__';
const GLOBAL_LIMIT = 60;
const GLOBAL_WINDOW_SECONDS = 15 * 60;

const DUMMY_PASSWORD = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';

function makeDummyRecord(env) {
  const parsed = parseInt(env && env.PBKDF2_ITERATIONS, 10);
  const iterations = (Number.isFinite(parsed) && parsed >= 10000) ? parsed : 100000;
  return {
    password: DUMMY_PASSWORD,
    salt: DUMMY_SALT,
    passwordAlgorithm: `PBKDF2-${iterations}-SHA256`
  };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function onRequestPost({ request, env }) {
  try {
    const redirect = enforceHttps(request);
    if (redirect) return redirect;

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);

    // Per-IP limit
    const ipOk = await checkRateLimit(db, clientIP, 'login', IP_LIMIT, IP_WINDOW_SECONDS);
    if (!ipOk) return jsonResponse({ error: 'Too many attempts. Try again in 15 minutes.' }, 429, request);

    // Global limit (parallel to per-IP; slows distributed brute force)
    const globalOk = await checkRateLimit(db, GLOBAL_KEY, 'login', GLOBAL_LIMIT, GLOBAL_WINDOW_SECONDS);
    if (!globalOk) return jsonResponse({ error: 'Too many attempts. Try again in 15 minutes.' }, 429, request);

    const body = await parseJSONSafely(request);
    const cleanEmail = String(body.email || '').toLowerCase().trim();
    const cleanPassword = String(body.password || '');

    if (!validateEmail(cleanEmail) || !cleanPassword) {
      await recordRateLimit(db, clientIP, 'login');
      await recordRateLimit(db, GLOBAL_KEY, 'login');
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}

    const user = guests.find(g => String(g.email || '').toLowerCase() === cleanEmail);

    // Always call verifyPassword, even for a non-existent user, so the
    // response time doesn't leak whether the account exists.
    const recordToCheck = user || makeDummyRecord(env);
    const verified = await verifyPassword(cleanPassword, recordToCheck, env);

    if (!user || !verified.ok) {
      await recordRateLimit(db, clientIP, 'login');
      await recordRateLimit(db, GLOBAL_KEY, 'login');
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    // Transparently migrate legacy SHA-256 hashes to PBKDF2.
    // This is a hash-format upgrade, not a password change, so we do
    // NOT bump sessionVersion — existing sessions stay valid.
    if (verified.legacy) {
      const fresh = await hashPassword(cleanPassword, env);
      user.password = fresh.hash;
      user.salt = fresh.salt;
      user.passwordAlgorithm = fresh.algorithm;
      user.passwordVersion = (user.passwordVersion ?? 0) + 1;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests)).run();
    }

    const sessionVersion = Number(user.sessionVersion ?? 0);

    const session = await createSignedToken({
      type: 'guest',
      userId: String(user.id),
      email: user.email,
      passwordVersion: Number(user.passwordVersion ?? 1),
      sessionVersion: sessionVersion
    }, env, GUEST_TTL_MS);

    // CSRF token MUST be issued under the same sessionVersion as the
    // session token, or the session-bound CSRF check will reject it.
    const csrfToken = await generateCSRFToken(user.id, env, sessionVersion);
    const { password: _, salt: __, ...safeUser } = user;

    // Two Set-Cookie directives:
    //   1. Set the new guest_token.
    //   2. Clear admin_token so this browser can no longer be
    //      mistaken for an admin. Prevents the session-collision leak
    //      where a guest page fell through to the admin branch.
    //
    // We deliberately DO NOT clear owner_token. Guest + owner
    // coexistence is a supported scenario; _middleware.js tries both
    // sessions when validating CSRF.
    const headers = new Headers(corsHeaders(request));
    headers.set('Cache-Control', 'no-store');
    headers.append('Set-Cookie', cookieHeader('guest_token', session, GUEST_TTL_SECONDS));
    headers.append('Set-Cookie', clearCookieHeader('admin_token'));

    return new Response(JSON.stringify({
      success: true,
      guest: safeUser,
      verified: user.verified === true,
      csrfToken,
      expiresIn: GUEST_TTL_SECONDS,
      message: 'Login successful'
    }), {
      status: 200,
      headers
    });
  } catch (e) {
    console.error('Login error:', e.message);
    return jsonResponse({ error: 'Login failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
