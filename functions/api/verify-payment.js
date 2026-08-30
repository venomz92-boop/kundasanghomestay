// /api/verify-payment.js – Chip only (no ToyyibPay)
import { corsHeaders } from './_utils.js';

// ===== Helper: JSON response =====
function jsonResponse(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
  });
}

// ===== Main handler =====
export async function onRequestPost({ request, env }) {
  try {
    const { bookingId } = await request.json();
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Database not configured' }, 500, request);
    }

    // Fetch booking
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx === -1) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }

    const booking = bookings[idx];

    // Already paid?
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({ success: true, booking, paid: true }, 200, request);
    }

    // Must have Chip purchase ID
    if (!booking.chip_purchase_id) {
      return jsonResponse({
        success: false,
        message: 'No Chip purchase found for this booking.',
        paymentStatus: 'pending',
        retry: true
      }, 200, request);
    }

    // Check Chip purchase status
    const chipSecret = env.CHIP_SECRET_KEY;
    if (!chipSecret) {
      return jsonResponse({ error: 'CHIP_SECRET_KEY not configured' }, 500, request);
    }

    const chipApi = 'https://gate.chip-in.asia/api/v1/purchases/' + booking.chip_purchase_id;
    let resp;
    try {
      resp = await fetch(chipApi, { headers: { 'Authorization': 'Bearer ' + chipSecret } });
    } catch (e) {
      console.error('Chip fetch error:', e.message);
      return jsonResponse({ error: 'Chip API unreachable' }, 502, request);
    }

    let purchase;
    try {
      purchase = await resp.json();
    } catch (e) {
      console.error('Chip parse error:', e.message);
      return jsonResponse({ error: 'Invalid Chip response' }, 502, request);
    }

    if (!resp.ok) {
      console.error('Chip error response:', purchase);
      return jsonResponse({ error: 'Chip API error: ' + (purchase.message || 'unknown') }, 502, request);
    }

    // If status is 'completed' or 'paid', update booking
    if (purchase.status === 'completed' || purchase.status === 'paid') {
      if (!booking.checkinCode) {
        booking.checkinCode = Math.floor(100000 + Math.random() * 900000).toString();
      }
      bookings[idx] = {
        ...booking,
        status: 'Paid - Awaiting Check-in',
        paid_at: new Date().toISOString(),
        chip_status: 'paid'
      };
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      return jsonResponse({
        success: true,
        booking: bookings[idx],
        paymentStatus: 'paid'
      }, 200, request);
    } else {
      // Still pending
      return jsonResponse({
        success: false,
        booking,
        paymentStatus: purchase.status || 'pending',
        retry: true
      }, 200, request);
    }

  } catch (e) {
    console.error('❌ verify-payment error:', e.message);
    return jsonResponse({ error: 'Internal error: ' + e.message }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
