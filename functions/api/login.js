// /api/login.js — Guest login.
//
// [THIS REVISION — 17 Sept 2026]
// When a guest logs in, the `admin_token` cookie is now explicitly
// cleared in the response. Root cause of a real leak: a browser that
// had an admin session (from a prior /admin.html login) and then
// logged in as a guest would hold BOTH cookies. If the guest session
// check on /api/bookings ever failed (e.g. session version bump,
// signature mismatch), the server fell through to the admin branch
// and returned the entire platform's bookings to the guest page,
// which then displayed them. Killing the admin cookie on guest login
// removes the ambiguity: one browser, one identity.
import {
  corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword,
  createSignedToken, generateCSRFToken, cookieHeader, clearCookieHeader,
  jsonResponse, checkRateLimit, recordRateLimit, parseJSONSafely
} from './_utils.js';

const GUEST_TTL_MS      = 30 * 24 * 60 * 60 * 1000;  // 30 days
const GUEST_TTL_SECONDS = GUEST_TTL_MS / 1000;

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

    const rateOk = await checkRateLimit(db, clientIP, 'login', 5, 15 * 60);
    if (!rateOk) return jsonResponse({ error: 'Too many attempts. Try again in 15 minutes.' }, 429, request);

    const body = await parseJSONSafely(request);
    const cleanEmail = String(body.email || '').toLowerCase().trim();
    const cleanPassword = String(body.password || '');

    if (!validateEmail(cleanEmail) || !cleanPassword) {
      await recordRateLimit(db, clientIP, 'login');
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}

    const user = guests.find(g => String(g.email || '').toLowerCase() === cleanEmail);

    const recordToCheck = user || makeDummyRecord(env);
    const verified = await verifyPassword(cleanPassword, recordToCheck, env);

    if (!user || !verified.ok) {
      await recordRateLimit(db, clientIP, 'login');
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    // Transparently migrate legacy SHA-256 hashes to PBKDF2
    if (verified.legacy) {
      const fresh = await hashPassword(cleanPassword, env);
      user.password = fresh.hash;
      user.salt = fresh.salt;
      user.passwordAlgorithm = fresh.algorithm;
      user.passwordVersion = (user.passwordVersion || 0) + 1;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests)).run();
    }

    const sessionVersion = user.sessionVersion || 0;

    const session = await createSignedToken({
      type: 'guest',
      userId: String(user.id),
      email: user.email,
      passwordVersion: user.passwordVersion || 1,
      sessionVersion: sessionVersion
    }, env, GUEST_TTL_MS);

    const csrfToken = await generateCSRFToken(user.id, env);
    const { password: _, salt: __, ...safeUser } = user;

    // Build headers with TWO Set-Cookie directives:
    //   1. Set the new guest_token.
    //   2. Clear the admin_token so this browser can no longer be
    //      mistaken for an admin. Prevents the session-collision leak.
    const headers = new Headers(corsHeaders(request, env));
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
    console.error('Login error:', e.message, e.stack);
    return jsonResponse({ error: 'Login failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}
