import { corsHeaders } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const raw = await request.text();
    const body = JSON.parse(raw);
    const bookingId = body.bookingId;

    const db = env.DB;
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = JSON.parse(r?.data || '[]');
    const booking = bookings.find(b => String(b.id) === bookingId);

    if (!booking) {
      return new Response(JSON.stringify({ error: 'Booking not found' }), {
        status: 404,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // Return the billcode and the getBill response
    const secret = env.TOYYIBPAY_SECRET_KEY;
    const billcode = booking.toyyibpay_billcode;
    const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}`;
    const res = await fetch(url);
    const billData = await res.json();

    return new Response(JSON.stringify({
      billcode,
      billData,
      bookingStatus: booking.status,
      secretProvided: !!secret
    }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}
