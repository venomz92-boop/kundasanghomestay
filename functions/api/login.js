// /api/login.js — Guest login with 2-hour session
import {
  corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword,
  createSignedToken, generateCSRFToken, cookieHeader, jsonResponse,
  checkRateLimit, recordRateLimit, parseJSONSafely, incrementSessionVersion
} from './_utils.js';

const GUEST_TTL_MS      = 2 * 60 * 60 * 1000;  // 2 hours
const GUEST_TTL_SECONDS = GUEST_TTL_MS / 1000;

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
    if (!user) return jsonResponse({ error: 'Invalid email or password' }, 401, request);

    const verified = await verifyPassword(cleanPassword, user, env);
    if (!verified.ok) {
      await recordRateLimit(db, clientIP, 'login');
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    if (verified.legacy) {
      const fresh = await hashPassword(cleanPassword, env);
      user.password = fresh.hash;
      user.salt = fresh.salt;
      user.passwordAlgorithm = fresh.algorithm;
      user.passwordVersion = (user.passwordVersion || 0) + 1;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests)).run();
    }

    if (user.verified !== true) {
      return jsonResponse({ error: 'Please verify your email first.' }, 401, request);
    }

    await incrementSessionVersion(db, user.id, 'guest');

    const session = await createSignedToken({
      type: 'guest',
      userId: String(user.id),
      email: user.email,
      passwordVersion: user.passwordVersion || 1,
      sessionVersion: (user.sessionVersion || 0) + 1
    }, env, GUEST_TTL_MS);

    const csrfToken = await generateCSRFToken(user.id, env);
    const { password: _, salt: __, ...safeUser } = user;

    return new Response(JSON.stringify({
      success: true,
      guest: safeUser,
      token: session,
      csrfToken,
      expiresIn: GUEST_TTL_SECONDS,
      message: 'Login successful'
    }), {
      status: 200,
      headers: {
        ...corsHeaders(request),
        'Set-Cookie': cookieHeader('guest_token', session, GUEST_TTL_SECONDS)
      }
    });
  } catch (e) {
    console.error('Login error:', e.message, e.stack);
    return jsonResponse({ error: 'Login failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
