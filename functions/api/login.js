// /api/login.js - Full patched with email verification check
import { corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword, createSignedToken, generateCSRFToken, cookieHeader, jsonResponse, parseJSONSafely, logAction, sendVerificationEmail } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
const attempts = new Map();

function limited(key) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, recent);
  return recent.length >= 5;
}
function record(key) { const a = attempts.get(key) || []; a.push(Date.now()); attempts.set(key, a); }

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    let body;
    try {
      body = await parseJSONSafely(request);
    } catch (e) {
      return jsonResponse({ error: 'Invalid JSON or payload too large' }, 400, request);
    }

    const { email, password } = body;
    const cleanEmail = String(email || '').toLowerCase().trim();
    const cleanPassword = String(password || '');
    const ip = getClientIP(request);
    const key = `${ip}:${cleanEmail}`;

    if (!validateEmail(cleanEmail) || !cleanPassword) {
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }
    if (limited(key)) {
      return jsonResponse({ error: 'Too many login attempts. Please try again later.' }, 429, request);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    const bannedR = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_banned_guests').first();

    let guests = [], banned = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}
    try { if (bannedR?.data) banned = JSON.parse(bannedR.data); } catch (_) {}

    if (banned.includes(cleanEmail)) {
      record(key);
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const user = guests.find(g => String(g.email || '').toLowerCase() === cleanEmail);
    if (!user) {
      record(key);
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    // ===== EMAIL VERIFICATION CHECK =====
    if (!user.verified) {
      // Resend verification email
      const token = await createSignedToken({
        type: 'email_verification',
        userId: user.id,
        email: user.email
      }, env, 24 * 60 * 60 * 1000);

      const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
      const verifyUrl = `${domain}/api/verify-email?token=${encodeURIComponent(token)}`;
      // Use the sendVerificationEmail helper (must be exported from _utils.js)
      if (typeof sendVerificationEmail === 'function') {
        await sendVerificationEmail(user.email, user.name, verifyUrl, env);
      } else {
        // Fallback: just log
        console.error('sendVerificationEmail not available');
      }

      return jsonResponse({
        error: 'Please verify your email address before logging in. A new verification link has been sent to your email.',
        needsVerification: true,
        email: user.email
      }, 403, request);
    }

    const verified = await verifyPassword(cleanPassword, user, env);
    if (!verified.ok) {
      record(key);
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    // Legacy migration
    if (verified.legacy) {
      const fresh = await hashPassword(cleanPassword, env);
      user.password = fresh.hash;
      user.salt = fresh.salt;
      user.passwordAlgorithm = fresh.algorithm;
      user.passwordVersion = (user.passwordVersion || 0) + 1;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests))
        .run();
    }

    attempts.delete(key);

    // Create session token with sessionVersion
    const session = await createSignedToken({
      type: 'guest',
      userId: String(user.id),
      email: user.email,
      passwordVersion: user.passwordVersion || 1,
      sessionVersion: user.sessionVersion || 0
    }, env);

    const csrfToken = await generateCSRFToken(user.id, env);
    const { password: _, salt: __, ...safeUser } = user;

    return new Response(JSON.stringify({
      success: true,
      guest: safeUser,
      token: session,
      csrfToken,
      message: 'Login successful'
    }), {
      status: 200,
      headers: {
        ...corsHeaders(request),
        'Set-Cookie': cookieHeader('guest_token', session)
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
