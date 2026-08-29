// /api/verify-payment.js
import { corsHeaders } from './_utils.js';

async function fetchBillStatus(billcode, secret, retries = 3) {
  const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}`;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'KundasangHomestay/1.0' },
        cf: { cacheTtl: 0 }
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (e) {
        if (i === retries - 1) throw new Error('Invalid JSON: ' + text.slice(0, 200));
        continue;
      }
      return data;
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

    // Simulation
    if (booking.toyyibpay_billcode && booking.toyyibpay_billcode.startsWith('SIM-')) {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return new Response(JSON.stringify({ 
        success: true, 
        booking: bookings[idx] 
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // Already paid?
    if (booking.status && booking.status.toLowerCase().includes('paid')) {
      return new Response(JSON.stringify({ success: true, booking }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // Already failed? Return failure state so frontend can show retry option
    if (booking.status && booking.status.toLowerCase().includes('fail')) {
      return new Response(JSON.stringify({ 
        success: false, 
        message: 'Payment failed. Please retry.',
        booking,
        retry: true 
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // No billcode
    if (!booking.toyyibpay_billcode) {
      return new Response(JSON.stringify({ 
        success: false, 
        message: 'No billcode',
        booking 
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // Real – fetch with retry
    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      return new Response(JSON.stringify({ error: 'Secret missing' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    let billData;
    try {
      billData = await fetchBillStatus(booking.toyyibpay_billcode, secret, 3);
    } catch (e) {
      // If fetch fails, return a "try again" message – frontend will retry
      return new Response(JSON.stringify({
        success: false,
        message: 'Payment verification pending. Please wait a moment.',
        retry: true,
        booking
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
      return new Response(JSON.stringify({ 
        success: true, 
        booking: bookings[idx] 
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    } else {
      // Payment not successful – mark as failed if appropriate
      // ToyyibPay status 0 means unpaid, 3 means expired/cancelled
      const billStatus = billData && billData[0] ? billData[0].billpaymentStatus : null;
      if (billStatus === "3") {
        bookings[idx].status = 'Payment Failed';
        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(bookings)).run();
      }
      return new Response(JSON.stringify({
        success: false,
        message: billStatus === "3" ? 'Payment failed or expired.' : 'Payment not yet confirmed. Please wait a moment.',
        retry: billStatus === "3" ? true : false,
        booking: bookings[idx]
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

  } catch (e) {
    console.error('❌ verify-payment error:', e.message);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
