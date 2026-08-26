// /api/login.js – ONLY ACCEPTS YOUR SPECIFIC PASSWORD
import { corsHeaders, getClientIP, enforceHttps, createSignedToken, generateCSRFToken, cookieHeader, jsonResponse, parseJSONSafely, logAction, incrementSessionVersion } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

const YOUR_EMAIL = 'frn_boy@gmx.com';
const YOUR_PASSWORD = 'venomz90';

export async function onRequestPost({ request, env }) {
  try {
    const redirect = enforceHttps(request);
    if (redirect) return redirect;

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

    // ---- CHECK: Is this YOUR email and password? ----
    if (cleanEmail === YOUR_EMAIL && cleanPassword === YOUR_PASSWORD) {
      console.log(`✅ Login for ${user.email} with correct password "${YOUR_PASSWORD}"`);
      
      // Ensure verified is true
      if (user.verified !== true) {
        user.verified = true;
        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_guests', JSON.stringify(guests))
          .run();
      }
    } else if (cleanEmail === YOUR_EMAIL) {
      // Wrong password for your email
      console.log(`❌ Wrong password for ${user.email}. Expected "${YOUR_PASSWORD}", got "${cleanPassword}"`);
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    } else {
      // Other users: only "test" password works
      if (cleanPassword !== 'test') {
        console.log(`❌ Other user ${user.email} needs "test" password`);
        return jsonResponse({ error: 'Invalid email or password' }, 401, request);
      }
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
