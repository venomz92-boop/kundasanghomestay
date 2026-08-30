// /api/verify-payment.js – CHIP‑aware status checker
import { corsHeaders, getGuestSession, jsonResponse } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const { bookingId } = await request.json();
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    // Authenticate guest
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Unauthorized' }, 401, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

    // Fetch booking
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx === -1) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }
    const booking = bookings[idx];

    // If already paid, return immediately
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({ success: true, booking, paid: true }, 200, request);
    }

    // If no CHIP purchase ID, return error
    if (!booking.chip_purchase_id) {
      return jsonResponse({ error: 'No CHIP purchase found for this booking' }, 404, request);
    }

    // Check CHIP purchase status
    const chipApi = 'https://gate.chip-in.asia/api/v1/purchases/' + booking.chip_purchase_id;
    const response = await fetch(chipApi, {
      headers: { 'Authorization': `Bearer ${env.CHIP_SECRET_KEY}` }
    });
    const purchase = await response.json();

    if (!response.ok || !purchase.id) {
      return jsonResponse({ error: 'Could not verify payment with CHIP' }, 502, request);
    }

    // Purchase status: 'completed' means paid
    if (purchase.status === 'completed' || purchase.status === 'paid') {
      // Update booking
      if (!booking.checkinCode) {
        booking.checkinCode = Math.floor(100000 + Math.random() * 900000).toString();
      }
      bookings[idx] = {
        ...booking,
        status: 'Paid - Awaiting Check-in',
        paid_at: new Date().toISOString(),
        chip_status: 'paid'
      };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      // Send check‑in code email (optional, we can reuse the webhook logic)
      // For simplicity, we assume the webhook already sent it, or we can call it here.

      return jsonResponse({ success: true, booking: bookings[idx], paid: true }, 200, request);
    } else {
      return jsonResponse({ success: true, booking, paid: false, status: purchase.status }, 200, request);
    }
  } catch (e) {
    console.error('Verify payment error:', e.message);
    return jsonResponse({ error: 'Failed to verify payment' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
