import { corsHeaders } from './_utils.js';

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
    const billcode = booking.toyyibpay_billcode;

    // ---- Simulation ----
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
      return new Response(JSON.stringify({ success: false, message: 'No billcode' }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // ---- Real Bill – Return Manual Check URL (Safe) ----
    const secret = env.TOYYIBPAY_SECRET_KEY;
    const checkUrl = secret
      ? `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}`
      : null;

    return new Response(JSON.stringify({
      success: false,
      message: 'Manual verification required',
      billcode,
      manualCheckUrl: checkUrl,
      bookingStatus: booking.status,
      // Admin can use this to manually mark paid via the admin panel
      adminNote: 'Use the admin panel to mark this booking as paid if you confirm payment.'
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
