import { corsHeaders } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const raw = await request.text();
    let body;
    try { body = JSON.parse(raw); } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const bookingId = body.bookingId;
    if (!bookingId) {
      return new Response(JSON.stringify({ error: 'Missing bookingId' }), {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: 'DB not found' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try { bookings = JSON.parse(r?.data || '[]'); } catch (e) {
      return new Response(JSON.stringify({ error: 'Parse error' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx === -1) {
      return new Response(JSON.stringify({ error: 'Booking not found' }), {
        status: 404,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const booking = bookings[idx];
    const billcode = booking.toyyibpay_billcode || null;
    const secret = env.TOYYIBPAY_SECRET_KEY || null;

    // ---- Simulation mode ----
    if (billcode && billcode.startsWith('SIM-')) {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return new Response(JSON.stringify({ success: true, booking: bookings[idx] }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // ---- No billcode ----
    if (!billcode) {
      return new Response(JSON.stringify({
        success: false,
        message: 'No billcode associated with this booking'
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // ---- Return billcode & secret status (manual verification) ----
    return new Response(JSON.stringify({
      success: false,
      message: 'Payment not yet confirmed (manual verification needed)',
      billcode: billcode,
      secretProvided: !!secret,
      bookingStatus: booking.status,
      // Build the manual check URL for the admin
      manualCheckUrl: secret ? `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}` : null
    }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Internal: ' + e.message }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}
