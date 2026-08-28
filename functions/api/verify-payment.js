// /api/verify-payment.js
import { corsHeaders } from './_utils.js';

// ===== POST =====
export async function onRequestPost({ request, env }) {
  try {
    const raw = await request.text();
    const body = JSON.parse(raw);
    const bookingId = body.bookingId;

    const db = env.DB;
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = JSON.parse(r?.data || '[]');
    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx === -1) {
      return new Response(JSON.stringify({ error: 'Booking not found' }), {
        status: 404,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const booking = bookings[idx];

    // ---- Simulation ----
    if (booking.toyyibpay_billcode && booking.toyyibpay_billcode.startsWith('SIM-')) {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return new Response(JSON.stringify({ success: true, booking: bookings[idx] }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // ---- Check if already paid (webhook may have updated) ----
    if (booking.status && booking.status.toLowerCase().includes('paid')) {
      return new Response(JSON.stringify({ success: true, booking }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // ---- Still pending – return processing message ----
    return new Response(JSON.stringify({
      success: false,
      message: 'Payment is being processed. You will receive a confirmation shortly.'
    }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('❌ verify-payment error:', e.message);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}

// ===== GET (for debugging) =====
export async function onRequestGet({ request }) {
  return new Response('verify-payment GET works', {
    headers: corsHeaders(request)
  });
}

// ===== OPTIONS (for CORS) =====
export async function onRequestOptions({ request }) {
  return new Response(null, {
    headers: corsHeaders(request)
  });
}
