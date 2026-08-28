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

    const secret = env.TOYYIBPAY_SECRET_KEY;
    const billcode = booking.toyyibpay_billcode;

    if (!secret) {
      return new Response(JSON.stringify({ error: 'TOYYIBPAY_SECRET_KEY not set' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    if (!billcode) {
      return new Response(JSON.stringify({ error: 'No billcode stored for this booking' }), {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}`;
    const res = await fetch(url);
    const text = await res.text();

    // Check if the response is JSON
    let billData;
    try {
      billData = JSON.parse(text);
    } catch (e) {
      // The response is not JSON – return the raw text so you can see the error
      return new Response(JSON.stringify({
        error: 'ToyyibPay returned non-JSON response',
        status: res.status,
        responsePreview: text.slice(0, 500),
        billcode,
        secretProvided: !!secret
      }), {
        status: 502,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // If we got JSON, check the status
    if (billData && billData[0] && billData[0].billpaymentStatus === "1") {
      booking.status = 'Paid - Awaiting Check-in';
      booking.paid_at = new Date().toISOString();
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return new Response(JSON.stringify({ success: true, booking }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({
        success: false,
        message: 'Payment not yet confirmed',
        billData
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}
