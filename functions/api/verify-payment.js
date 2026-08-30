// /api/verify-payment.js – Hybrid: CHIP + ToyyibPay (based on your working version)
import { corsHeaders } from './_utils.js';

// ===== ToyyibPay helpers (unchanged from your original) =====
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

// ===== Helper: JSON response =====
function jsonResponse(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
  });
}

// ===== Main handler =====
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
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }

    const booking = bookings[idx];
    let paymentStatus = 'pending';

    // 1. Check if already paid
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({ success: true, booking, paid: true }, 200, request);
    }

    // 2. CHIP handling (NEW)
    if (booking.chip_purchase_id) {
      console.log(`🔍 Checking CHIP purchase: ${booking.chip_purchase_id}`);
      const chipSecret = env.CHIP_SECRET_KEY;
      if (!chipSecret) {
        return jsonResponse({ error: 'CHIP_SECRET_KEY not configured' }, 500, request);
      }
      const chipApi = 'https://gate.chip-in.asia/api/v1/purchases/' + booking.chip_purchase_id;
      let resp;
      try {
        resp = await fetch(chipApi, { headers: { 'Authorization': 'Bearer ' + chipSecret } });
      } catch (e) {
        console.error('CHIP fetch error:', e.message);
        return jsonResponse({ error: 'CHIP API unreachable' }, 502, request);
      }
      let purchase;
      try {
        purchase = await resp.json();
      } catch (e) {
        console.error('CHIP parse error:', e.message);
        return jsonResponse({ error: 'Invalid CHIP response' }, 502, request);
      }
      if (!resp.ok) {
        console.error('CHIP error response:', purchase);
        return jsonResponse({ error: 'CHIP API error: ' + (purchase.message || 'unknown') }, 502, request);
      }

      // If status is completed/paid, update
      if (purchase.status === 'completed' || purchase.status === 'paid') {
        if (!booking.checkinCode) {
          booking.checkinCode = Math.floor(100000 + Math.random() * 900000).toString();
        }
        bookings[idx] = {
          ...booking,
          status: 'Paid - Awaiting Check-in',
          paid_at: new Date().toISOString(),
          chip_status: 'paid'
        };
        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(bookings)).run();
        return jsonResponse({
          success: true,
          booking: bookings[idx],
          paymentStatus: 'paid'
        }, 200, request);
      } else {
        // Still pending or other status
        return jsonResponse({
          success: false,
          booking,
          paymentStatus: purchase.status || 'pending',
          retry: true
        }, 200, request);
      }
    }

    // ===== 3. ToyyibPay legacy handling (your original code) =====
    const statusLower = (booking.status || '').toLowerCase();
    if (statusLower.includes('paid')) paymentStatus = 'paid';
    else if (statusLower.includes('fail')) paymentStatus = 'failed';
    else if (statusLower.includes('pending')) paymentStatus = 'pending';

    // Simulation
    if (booking.toyyibpay_billcode && booking.toyyibpay_billcode.startsWith('SIM-')) {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return jsonResponse({
        success: true,
        booking: bookings[idx],
        paymentStatus: 'paid'
      }, 200, request);
    }

    if (paymentStatus === 'paid' || paymentStatus === 'failed') {
      return jsonResponse({
        success: paymentStatus === 'paid',
        booking,
        paymentStatus,
        retry: paymentStatus === 'failed' ? true : false
      }, 200, request);
    }

    if (!booking.toyyibpay_billcode) {
      return jsonResponse({
        success: false,
        message: 'No billcode',
        booking,
        paymentStatus: 'pending',
        retry: true
      }, 200, request);
    }

    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      return jsonResponse({ error: 'ToyyibPay secret missing' }, 500, request);
    }

    let billData;
    try {
      billData = await fetchBillStatus(booking.toyyibpay_billcode, secret, 3);
    } catch (e) {
      return jsonResponse({
        success: false,
        message: 'Payment verification pending. Please wait a moment.',
        retry: true,
        booking,
        paymentStatus: 'pending'
      }, 200, request);
    }

    if (billData && billData[0] && billData[0].billpaymentStatus === "1") {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      bookings[idx].toyyibpay_refno = billData[0].billpaymentTransactionId || '';
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return jsonResponse({
        success: true,
        booking: bookings[idx],
        paymentStatus: 'paid'
      }, 200, request);
    } else {
      const billStatus = billData && billData[0] ? billData[0].billpaymentStatus : null;
      if (billStatus === "3") {
        bookings[idx].status = 'Payment Failed';
        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(bookings)).run();
        return jsonResponse({
          success: false,
          message: 'Payment failed or expired.',
          retry: true,
          booking: bookings[idx],
          paymentStatus: 'failed'
        }, 200, request);
      } else {
        return jsonResponse({
          success: false,
          message: 'Payment not yet confirmed. Please wait a moment.',
          retry: true,
          booking: bookings[idx],
          paymentStatus: 'pending'
        }, 200, request);
      }
    }

  } catch (e) {
    console.error('❌ verify-payment error:', e.message);
    return jsonResponse({ error: 'Internal error: ' + e.message }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
