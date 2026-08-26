// /api/login.js – ULTRA PERMISSIVE (any password works)
import { corsHeaders, getClientIP, enforceHttps, createSignedToken, generateCSRFToken, cookieHeader, jsonResponse, parseJSONSafely } from './_utils.js';

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
    const { email } = body;
    const cleanEmail = String(email || '').toLowerCase().trim();

    if (!cleanEmail) {
      return jsonResponse({ error: 'Email is required' }, 400, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}

    const user = guests.find(g => String(g.email || '').toLowerCase() === cleanEmail);
    if (!user) {
      return jsonResponse({ error: 'User not found' }, 401, request);
    }

    // ---- ALWAYS LOG IN – skip password AND verification ----
    if (user.verified !== true) {
      user.verified = true;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests))
        .run();
    }

    const session = await createSignedToken({
      type: 'guest',
      userId: String(user.id),
      email: user.email,
      passwordVersion: user.passwordVersion || 1,
      sessionVersion: (user.sessionVersion || 0) + 1
    }, env);

    const csrfToken = await generateCSRFToken(user.id, env);
    const { password: _, salt: __, ...safeUser } = user;

    console.log(`✅ Login successful for ${user.email} (bypass)`);

    return new Response(JSON.stringify({
      success: true,
      guest: safeUser,
      token: session,
      csrfToken,
      message: 'Login successful (bypass)'
    }), {
      status: 200,
      headers: {
        ...corsHeaders(request),
        'Set-Cookie': cookieHeader('guest_token', session)
      }
    });

  } catch (e) {
    console.error('Login error:', e);
    return jsonResponse({ error: 'Login failed' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
