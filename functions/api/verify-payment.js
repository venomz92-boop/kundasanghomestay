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
      // ⚠️ Critical: ensure this saves
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
      console.log(`✅ Simulation: Booking ${bookingId} updated to PAID`);
      return new Response(JSON.stringify({ success: true, booking: bookings[idx] }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // ---- Real ToyyibPay ----
    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      return new Response(JSON.stringify({ error: 'Secret missing' }), { status: 500, headers: { ...corsHeaders(request), 'Content-Type': 'application/json' } });
    }

    const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}`;
    const res = await fetch(url);
    const text = await res.text();
    let billData;
    try { billData = JSON.parse(text); } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid response from ToyyibPay', preview: text.slice(0, 200) }), {
        status: 502,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    if (billData && billData[0] && billData[0].billpaymentStatus === "1") {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      bookings[idx].toyyibpay_refno = billData[0].billpaymentTransactionId || '';
      // ⚠️ Critical: ensure this saves
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
      console.log(`✅ Real payment: Booking ${bookingId} updated to PAID`);
      return new Response(JSON.stringify({ success: true, booking: bookings[idx] }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({ success: false, message: 'Payment not yet confirmed' }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

  } catch (e) {
    console.error('❌ verify-payment error:', e.message, e.stack);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}
