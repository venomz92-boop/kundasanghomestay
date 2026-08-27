// /api/owner-bookings.js
import { corsHeaders, enforceHttps, getOwnerSession, jsonResponse } from './_utils.js';

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const owner = await getOwnerSession(request, env);
  if (!owner || owner.type !== 'owner') {
    return jsonResponse({ error: 'Unauthorized' }, 401, request);
  }

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'Server error' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}

    const ids = (owner.homestayIds || [owner.ownerId]).map(String);
    const filtered = bookings.filter(b => ids.includes(String(b.homestayId)));

    // ===== REMOVE SENSITIVE checkinCode FIELD =====
    const safeBookings = filtered.map(b => {
      const { checkinCode, ...rest } = b;
      return rest;
    });

    return jsonResponse(safeBookings, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('Owner bookings error:', e.message);
    return jsonResponse({ error: 'Failed to load bookings' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
