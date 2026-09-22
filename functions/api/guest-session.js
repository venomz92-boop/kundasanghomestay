// /api/guest-session.js — SERVER FILE (inside /api/ folder).
// Tells the front-end "who is behind this cookie?".
import {
  corsHeaders,
  enforceHttps,
  getGuestSession,
  jsonResponse
} from './_utils.js';

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ authenticated: false }, 200, request, { 'Cache-Control': 'no-store' });
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ authenticated: false }, 200, request, { 'Cache-Control': 'no-store' });
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
    let guests = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}

    const guest = guests.find(g => String(g.id) === String(session.userId));
    if (!guest) {
      return jsonResponse({ authenticated: false }, 200, request, { 'Cache-Control': 'no-store' });
    }

    const {
      password,
      salt,
      passwordAlgorithm,
      passwordVersion,
      sessionVersion,
      verifiedAt,
      ...safeGuest
    } = guest;

    return jsonResponse({
      authenticated: true,
      guest: safeGuest
    }, 200, request, { 'Cache-Control': 'no-store' });

  } catch (e) {
    console.error('guest-session error:', e.message);
    return jsonResponse({ authenticated: false }, 200, request, { 'Cache-Control': 'no-store' });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}
