// /api/login.js – with debug log and hardcoded test password bypass
import { corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword, createSignedToken, generateCSRFToken, cookieHeader, jsonResponse, checkRateLimit, recordRateLimit, parseJSONSafely, logAction, incrementSessionVersion } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

export async function onRequestPost({ request, env }) {
  try {
    const redirect = enforceHttps(request);
    if (redirect) return redirect;

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      console.error('DB not configured');
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    // Rate limiting (disable for debugging)
    // const rateOk = await checkRateLimit(db, clientIP, 'login', 5, 15 * 60);
    // if (!rateOk) {
    //   return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    // }

    let body;
    try {
      body = await parseJSONSafely(request);
    } catch (e) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }
    const { email, password } = body;
    const cleanEmail = String(email || '').toLowerCase().trim();
    const cleanPassword = String(password || '');

    if (!validateEmail(cleanEmail) || !cleanPassword) {
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    const bannedR = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_banned_guests').first();

    let guests = [], banned = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) { console.error('Failed to parse guests'); }
    try { if (bannedR?.data) banned = JSON.parse(bannedR.data); } catch (_) {}

    // Check banned
    if (banned.includes(cleanEmail)) {
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const user = guests.find(g => String(g.email || '').toLowerCase() === cleanEmail);
    if (!user) {
      console.warn(`❌ User not found: ${cleanEmail}`);
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    // ---- LOG FULL USER RECORD ----
    console.log('🔍 User record:', JSON.stringify(user, null, 2));

    // ---- TEMPORARY BYPASS: allow login with password "test" ----
    if (cleanPassword === 'test') {
      console.log(`⚠️ Bypass login for ${user.email} using hardcoded "test" password`);
      // Skip password verification and proceed
    } else {
      // Normal password verification
      const verified = await verifyPassword(cleanPassword, user, env);
      if (!verified.ok) {
        console.warn(`❌ Password mismatch for ${user.email}`);
        return jsonResponse({ error: 'Invalid email or password' }, 401, request);
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
        console.log(`✅ Migrated password for ${user.email}`);
      }
    }

    // ---- Set verified to true for all users during testing ----
    if (user.verified !== true) {
      user.verified = true;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests))
        .run();
      console.log(`✅ Marked ${user.email} as verified`);
    }

    // Increment session version
    await incrementSessionVersion(db, user.id, 'guest');

    const session = await createSignedToken({
      type: 'guest',
      userId: String(user.id),
      email: user.email,
      passwordVersion: user.passwordVersion || 1,
      sessionVersion: (user.sessionVersion || 0) + 1
    }, env);

    const csrfToken = await generateCSRFToken(user.id, env);
    const { password: _, salt: __, ...safeUser } = user;

    console.log(`✅ Login successful for ${user.email}`);

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
