// /api/login.js
import { corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword, createSignedToken, generateCSRFToken, cookieHeader, jsonResponse } from './_utils.js';

if (!user.verified) {
  // Optionally, send a new verification email and block login
  // We'll return an error with instructions
  return jsonResponse({ 
    error: 'Please verify your email address first. A new verification link has been sent to your email.',
    needsVerification: true
  }, 401, request);
}

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
    const { email, password } = await request.json();
    const cleanEmail = String(email || '').toLowerCase().trim();
    const cleanPassword = String(password || '');
    const ip = getClientIP(request);
    const key = `${ip}:${cleanEmail}`;
    if (!validateEmail(cleanEmail) || !cleanPassword) return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    if (limited(key)) return jsonResponse({ error: 'Too many login attempts. Please try again later.' }, 429, request);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    const bannedR = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_banned_guests').first();
    let guests = [], banned = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}
    try { if (bannedR?.data) banned = JSON.parse(bannedR.data); } catch (_) {}
    if (banned.includes(cleanEmail)) { record(key); return jsonResponse({ error: 'Invalid credentials' }, 401, request); }

    const user = guests.find(g => String(g.email || '').toLowerCase() === cleanEmail);
    if (!user) { record(key); return jsonResponse({ error: 'Invalid credentials' }, 401, request); }
    const verified = await verifyPassword(cleanPassword, user, env);
    if (!verified.ok) { record(key); return jsonResponse({ error: 'Invalid credentials' }, 401, request); }

    // Transparent migration from legacy SHA-256
    if (verified.legacy) {
      const fresh = await hashPassword(cleanPassword, env);
      user.password = fresh.hash;
      user.salt = fresh.salt;
      user.passwordAlgorithm = fresh.algorithm;
      user.passwordVersion = 1; // set version on upgrade
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests))
        .run();
    }

    attempts.delete(key);
    const session = await createSignedToken({
      type: 'guest',
      userId: String(user.id),
      email: user.email,
      passwordVersion: user.passwordVersion || 1
    }, env);
    const csrfToken = await generateCSRFToken(user.id, env);
    const { password: _, salt: __, ...safeUser } = user;

    return new Response(JSON.stringify({ success: true, guest: safeUser, token: session, csrfToken, message: 'Login successful' }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Set-Cookie': cookieHeader('guest_token', session) }
    });
  } catch (e) {
    console.error('Login error:', e.message, e.stack);
    return jsonResponse({ error: 'Login failed. Please try again later.' }, 500, request);
  }
}
export async function onRequestOptions({ request }) { return new Response(null, { headers: corsHeaders(request) }); }
