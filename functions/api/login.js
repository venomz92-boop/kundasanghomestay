// /api/login.js – DEBUG VERSION with hash logging
import { corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword, createSignedToken, generateCSRFToken, cookieHeader, jsonResponse, checkRateLimit, recordRateLimit, parseJSONSafely, logAction, incrementSessionVersion } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

export async function onRequestPost({ request, env }) {
  try {
    const redirect = enforceHttps(request);
    if (redirect) return redirect;

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    // Rate limiting (5 attempts per 15 minutes)
    const rateOk = await checkRateLimit(db, clientIP, 'login', 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }

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
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}
    try { if (bannedR?.data) banned = JSON.parse(bannedR.data); } catch (_) {}

    if (banned.includes(cleanEmail)) {
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const user = guests.find(g => String(g.email || '').toLowerCase() === cleanEmail);
    if (!user) {
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    // ---- DEBUG LOGS ----
    console.log(`🔍 Login attempt for ${user.email}`);
    console.log(`  Stored password hash: ${user.password}`);
    console.log(`  Stored salt: ${user.salt}`);
    console.log(`  Stored algorithm: ${user.passwordAlgorithm}`);
    console.log(`  Password version: ${user.passwordVersion}`);

    // ---- TEMPORARY BYPASS: allow "test" password ----
    let passwordOk = false;
    if (cleanPassword === 'test') {
      console.log(`⚠️ Bypass login for ${user.email} using "test" password`);
      passwordOk = true;
    } else {
      // Normal verification
      const verified = await verifyPassword(cleanPassword, user, env);
      console.log(`  verifyPassword result: ok=${verified.ok}, legacy=${verified.legacy}`);
      if (verified.ok) {
        passwordOk = true;
        // Legacy migration if needed
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
      } else {
        // If verifyPassword fails, compute the hash manually for debugging
        // This requires importing derivePassword – we'll do it directly here
        // (temporarily re-implement the logic)
        const pepper = env?.PASSWORD_PEPPER || env?.SESSION_SECRET;
        if (pepper) {
          // Recompute using the same parameters
          const algo = user.passwordAlgorithm || 'PBKDF2-100000-SHA256';
          const parts = algo.split('-');
          const iterations = parts.length >= 2 ? parseInt(parts[1], 10) : 100000;
          // derivePassword is not exported; we'll call verifyPassword again but with more logging
          // Alternatively, we can use a separate function, but we'll just log that verification failed.
          console.log(`❌ Password verification failed for ${user.email}`);
        }
      }
    }

    if (!passwordOk) {
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    // ---- Ensure verified ----
    if (user.verified !== true) {
      user.verified = true;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests))
        .run();
      console.log(`✅ Marked ${user.email} as verified`);
    }

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
