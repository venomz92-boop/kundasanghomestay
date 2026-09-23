// /api/owner-bookings.js
//
// [THIS REVISION]
// Owner's homestay IDs are now computed FRESH from kd_approved and
// kd_pending on every request, by matching the WhatsApp number from the
// session token. Previously this endpoint trusted the JWT's `homestayIds`
// array, which was a snapshot taken at login / email-verification time.
// A listing approved AFTER that moment was not in the snapshot, so its
// bookings were invisible on the owner dashboard even though the booking
// existed in D1. The fallback to the JWT snapshot is kept so any legacy
// session still works.
import { corsHeaders, enforceHttps, getOwnerSession, jsonResponse, computeCancellationTier } from './_utils.js';

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

    // Compute the owner's homestay IDs FRESH from D1 by matching WhatsApp.
    const cleanWa = String(owner.whatsapp || owner.ownerId || '').replace(/[^0-9]/g, '');

    const homestayIdSet = new Set();
    for (const key of ['kd_approved', 'kd_pending']) {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();
      if (!r?.data) continue;
      try {
        const arr = JSON.parse(r.data);
        arr.forEach(h => {
          const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
          if (hWa && hWa === cleanWa) homestayIdSet.add(String(h.id));
        });
      } catch (_) {}
    }

    // Fallback: if nothing matched by WhatsApp, use the JWT's snapshot.
    if (homestayIdSet.size === 0 && Array.isArray(owner.homestayIds)) {
      owner.homestayIds.forEach(id => homestayIdSet.add(String(id)));
    }

    const ids = [...homestayIdSet];

    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}

    const filtered = ids.length === 0
      ? []
      : bookings.filter(b => ids.includes(String(b.homestayId)));

    const safeBookings = filtered.map(b => {
      const { checkinCode, ...rest } = b;
      // If the guest has a request waiting, work out the tier and the
      // amounts now so the host sees them before deciding. Uses the
      // guest's recorded date — same maths the refund will use.
      if (rest.cancellationRequest && rest.cancellationRequest.status === 'pending_host') {
        const askedMs = Date.parse(rest.cancellationRequest.requestedAt);
        rest.tierPreview = computeCancellationTier(
          rest,
          Number.isFinite(askedMs) ? askedMs : Date.now()
        );
      }
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
