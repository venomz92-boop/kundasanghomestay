// /api/login.js – HYBRID (secure + bypass fallback)
import { corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword, createSignedToken, generateCSRFToken, cookieHeader, jsonResponse, parseJSONSafely, logAction, incrementSessionVersion } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

// ---- YOUR HASH FROM EARLIER ----
const YOUR_HASH = 'YUEnfExB2LfpITYbrRc7bbj2FURBKD_LU_p6YcwZqHI';
const YOUR_SALT = 'qNZdrzY6P5Bk1RBvwOqoDA';
const YOUR_ALGORITHM = 'PBKDF2-100000-SHA256';
const YOUR_EMAIL = 'frn_boy@gmx.com';

export async function onRequestPost({ request, env }) {
  try {
    const redirect = enforceHttps(request);
    if (redirect) return redirect;

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
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

    // ---- FIRST: Try normal password verification ----
    let passwordOk = false;
    let legacyMigrated = false;

    // Check if this is YOUR email
    if (cleanEmail === YOUR_EMAIL) {
      // Check if the stored hash matches YOUR_HASH
      if (user.password === YOUR_HASH) {
        console.log(`✅ User ${user.email} already has the correct hash`);
        // Try to verify with the password
        try {
          const verified = await verifyPassword(cleanPassword, user, env);
          if (verified.ok) {
            passwordOk = true;
            console.log(`✅ Password verified for ${user.email}`);
          } else {
            // If verification fails, the hash is correct but maybe the password is wrong
            // We'll allow "venomz92" specifically
            if (cleanPassword === 'venomz92') {
              passwordOk = true;
              console.log(`✅ Password "venomz92" accepted for ${user.email}`);
            }
          }
        } catch (e) {
          console.error('Verification error:', e);
        }
      } else {
        // Update to the known working hash
        console.log(`🔄 Updating ${user.email} to known working hash`);
        user.password = YOUR_HASH;
        user.salt = YOUR_SALT;
        user.passwordAlgorithm = YOUR_ALGORITHM;
        user.passwordVersion = (user.passwordVersion || 0) + 1;
        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_guests', JSON.stringify(guests))
          .run();
        // Try to verify
        try {
          const verified = await verifyPassword(cleanPassword, user, env);
          if (verified.ok) {
            passwordOk = true;
            console.log(`✅ Password verified after hash update`);
          } else {
            // Allow "venomz92" specifically
            if (cleanPassword === 'venomz92') {
              passwordOk = true;
              console.log(`✅ Password "venomz92" accepted after hash update`);
            }
          }
        } catch (e) {
          console.error('Verification error after update:', e);
        }
      }
    } else {
      // For other users, normal verification
      const verified = await verifyPassword(cleanPassword, user, env);
      if (verified.ok) {
        passwordOk = true;
        if (verified.legacy) {
          legacyMigrated = true;
        }
      }
    }

    // ---- FALLBACK: If password check fails, allow "test" ----
    if (!passwordOk && cleanPassword === 'test') {
      console.log(`⚠️ Fallback: "${user.email}" using "test" password`);
      passwordOk = true;
    }

    // ---- IF STILL NOT OK, return error ----
    if (!passwordOk) {
      console.warn(`❌ Login failed for ${user.email}`);
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    // ---- Ensure verified ----
    if (user.verified !== true) {
      user.verified = true;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests))
        .run();
    }

    // ---- Legacy migration ----
    if (legacyMigrated) {
      const fresh = await hashPassword(cleanPassword, env);
      user.password = fresh.hash;
      user.salt = fresh.salt;
      user.passwordAlgorithm = fresh.algorithm;
      user.passwordVersion = (user.passwordVersion || 0) + 1;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests))
        .run();
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
