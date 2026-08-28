import { corsHeaders } from './_utils.js';

function fetchWithTimeout(url, options, timeout = 5000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
  ]);
}

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

    if (!billcode) {
      return new Response(JSON.stringify({ success: false, message: 'No billcode' }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // ---- Real ToyyibPay ----
    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      return new Response(JSON.stringify({ error: 'Secret missing' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}`;
    let billData, fetchError = null;

    try {
      const res = await fetchWithTimeout(url, {}, 5000);
      const text = await res.text();
      try { billData = JSON.parse(text); } catch (e) {
        fetchError = 'Invalid JSON: ' + text.slice(0, 200);
      }
    } catch (e) {
      fetchError = e.message || 'Network error';
    }

    if (fetchError) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Verification failed: ' + fetchError,
        manualCheckUrl: url
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    if (billData && billData[0] && billData[0].billpaymentStatus === "1") {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      bookings[idx].toyyibpay_refno = billData[0].billpaymentTransactionId || '';
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
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
    return new Response(JSON.stringify({ error: 'Internal: ' + e.message }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}
