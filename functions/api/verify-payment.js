// /api/verify-payment.js
import { corsHeaders, getGuestSession, jsonResponse, getClientIP } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    console.log('📡 verify-payment called');

    const session = await getGuestSession(request, env);
    if (!session) return jsonResponse({ error: 'Unauthorized' }, 401, request);

    const { bookingId } = await request.json();
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try { bookings = JSON.parse(r?.data || '[]'); } catch (_) {}

    const idx = bookings.findIndex(b =>
      String(b.id) === bookingId &&
      String(b.guestId) === String(session.userId)
    );
    if (idx < 0) return jsonResponse({ error: 'Booking not found' }, 404, request);

    const booking = bookings[idx];
    if (booking.status && booking.status.toLowerCase().includes('paid')) {
      return jsonResponse({ success: true, booking, message: 'Already paid' }, 200, request);
    }

    if (!booking.toyyibpay_billcode) {
      return jsonResponse({ error: 'No billcode' }, 400, request);
    }

    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) return jsonResponse({ error: 'Payment gateway not configured' }, 500, request);

    const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${booking.toyyibpay_billcode}&userSecretKey=${secret}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data && data[0] && data[0].billpaymentStatus === "1") {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = data[0].billpaymentDatetime || new Date().toISOString();
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return jsonResponse({ success: true, booking: bookings[idx] }, 200, request);
    } else {
      return jsonResponse({ success: false, message: 'Payment not yet confirmed' }, 200, request);
    }
  } catch (e) {
    console.error('❌ verify-payment error:', e.message, e.stack);
    return jsonResponse({ error: 'Internal error: ' + e.message }, 500, request);
  }
}
