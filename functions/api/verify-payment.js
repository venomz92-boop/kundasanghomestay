// /api/verify-payment.js
import { corsHeaders, getGuestSession, jsonResponse, getClientIP } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    console.log('📡 verify-payment called');

    const rawBody = await request.text();
    let body;
    try { body = JSON.parse(rawBody); } catch (e) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, request);
    }

    const session = await getGuestSession(request, env);
    if (!session) return jsonResponse({ error: 'Unauthorized' }, 401, request);

    const bookingId = body.bookingId;
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

    // Already paid?
    if (booking.status && booking.status.toLowerCase().includes('paid')) {
      return jsonResponse({ success: true, booking, message: 'Already paid' }, 200, request);
    }

    // ===== 🔥 FIX: Auto‑confirm simulation bookings =====
    if (booking.toyyibpay_billcode && booking.toyyibpay_billcode.startsWith('SIM-')) {
      console.log(`✅ Simulation billcode detected for ${bookingId}, marking as paid.`);
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      bookings[idx].simulation = true;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return jsonResponse({ success: true, booking: bookings[idx], message: 'Simulated payment confirmed' }, 200, request);
    }

    // No billcode → cannot verify
    if (!booking.toyyibpay_billcode) {
      return jsonResponse({ error: 'No billcode associated with this booking' }, 400, request);
    }

    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) return jsonResponse({ error: 'Payment gateway not configured' }, 500, request);

    // Real ToyyibPay check
    const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${booking.toyyibpay_billcode}&userSecretKey=${secret}`;
    const res = await fetch(url);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      console.error('❌ Invalid JSON from ToyyibPay:', text);
      return jsonResponse({ error: 'Invalid response from payment gateway' }, 502, request);
    }

    if (data && data[0] && data[0].billpaymentStatus === "1") {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = data[0].billpaymentDatetime || new Date().toISOString();
      bookings[idx].toyyibpay_refno = data[0].billpaymentTransactionId || '';
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return jsonResponse({ success: true, booking: bookings[idx], message: 'Payment confirmed' }, 200, request);
    } else {
      return jsonResponse({ success: false, message: 'Payment not yet confirmed' }, 200, request);
    }
  } catch (e) {
    console.error('❌ verify-payment error:', e.message, e.stack);
    return jsonResponse({ error: 'Internal server error: ' + e.message }, 500, request);
  }
}

// GET for debugging
export async function onRequestGet({ request, env }) {
  try {
    const db = env.DB;
    const r = await db?.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    const count = r?.data ? JSON.parse(r.data).length : 0;
    return new Response(`verify-payment GET works. Bookings count: ${count}`, {
      headers: corsHeaders(request)
    });
  } catch (_) {
    return new Response('verify-payment GET works (DB not available)', {
      headers: corsHeaders(request)
    });
  }
}
