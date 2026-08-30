// /api/verify-payment.js – Minimal debug (no auth, no CHIP call)
import { corsHeaders } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const bookingId = body.bookingId;
    if (!bookingId) {
      return new Response(
        JSON.stringify({ error: 'Missing bookingId' }),
        { status: 400, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }

    const db = env.DB;
    if (!db) {
      return new Response(
        JSON.stringify({ error: 'DB not configured' }),
        { status: 500, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }

    // Read booking
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    if (r?.data) {
      try { bookings = JSON.parse(r.data); } catch (e) {}
    }
    const booking = bookings.find(b => String(b.id) === String(bookingId));
    if (!booking) {
      return new Response(
        JSON.stringify({ error: 'Booking not found' }),
        { status: 404, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }

    // Return basic info (no updates, just read)
    return new Response(
      JSON.stringify({
        success: true,
        bookingId: booking.id,
        status: booking.status,
        chip_purchase_id: booking.chip_purchase_id || null,
        hasChipId: !!booking.chip_purchase_id
      }),
      { status: 200, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('Minimal verify error:', e.message);
    return new Response(
      JSON.stringify({ error: 'Exception: ' + e.message }),
      { status: 500, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } }
    );
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
