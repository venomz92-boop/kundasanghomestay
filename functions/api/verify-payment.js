import { corsHeaders } from './_utils.js';

async function fetchWithRetry(url, options, retries = 2, timeout = 8000) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { ...options, signal: controller.signal, cf: { cacheTtl: 0 } });
      clearTimeout(timer);
      return res;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
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
    let billData = null;
    let fetchError = null;
    let rawResponse = '';

    try {
      const res = await fetchWithRetry(url, {}, 2, 8000);
      rawResponse = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${rawResponse.slice(0, 200)}`);
      }
      billData = JSON.parse(rawResponse);
    } catch (e) {
      fetchError = e.message || 'Network error';
      console.error('❌ fetch error:', fetchError);
      // Return manual check URL as fallback
      return new Response(JSON.stringify({
        success: false,
        message: 'Payment verification failed. Please check manually.',
        manualCheckUrl: url,
        billcode,
        rawResponse: rawResponse.slice(0, 500) // helpful for debugging
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // ---- Check status ----
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
    console.error('❌ verify-payment fatal:', e.message, e.stack);
    return new Response(JSON.stringify({ error: 'Internal: ' + e.message }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}
