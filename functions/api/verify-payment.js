// /api/verify-payment.js – Full version with CHIP check and status update
import { corsHeaders, getGuestSession } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const { bookingId } = await request.json();
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    // 1. Authenticate guest (optional but recommended)
    let session;
    try {
      session = await getGuestSession(request, env);
    } catch (_) {}
    // If session fails, we still proceed but only update if booking exists.

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'DB not configured' }, 500, request);
    }

    // 2. Read booking
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    if (r?.data) {
      try { bookings = JSON.parse(r.data); } catch (_) {}
    }
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx === -1) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }
    const booking = bookings[idx];

    // 3. If already paid, return
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({ success: true, booking, paid: true }, 200, request);
    }

    // 4. Check CHIP if we have purchase_id
    if (booking.chip_purchase_id) {
      const chipApi = 'https://gate.chip-in.asia/api/v1/purchases/' + booking.chip_purchase_id;
      let response;
      try {
        response = await fetch(chipApi, {
          headers: { 'Authorization': `Bearer ${env.CHIP_SECRET_KEY}` }
        });
      } catch (fetchErr) {
        console.error('CHIP fetch error:', fetchErr.message);
        return jsonResponse({ error: 'CHIP API unreachable' }, 502, request);
      }

      let purchase;
      try {
        purchase = await response.json();
      } catch (parseErr) {
        console.error('CHIP parse error:', parseErr.message);
        return jsonResponse({ error: 'Invalid CHIP response' }, 502, request);
      }

      if (!response.ok) {
        console.error('CHIP error:', purchase);
        return jsonResponse({ error: 'CHIP API error' }, 502, request);
      }

      // If status is 'completed' or 'paid', update booking
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
        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_bookings', JSON.stringify(bookings))
          .run();

        return jsonResponse({ success: true, booking: bookings[idx], paid: true }, 200, request);
      } else {
        // Not paid yet
        return jsonResponse({
          success: false,
          booking,
          paid: false,
          paymentStatus: purchase.status || 'pending',
          retry: true
        }, 200, request);
      }
    }

    // 5. Legacy ToyyibPay fallback (keep for old bookings)
    if (booking.toyyibpay_billcode) {
      return handleToyyibPay(booking, env, db, bookings, idx, request);
    }

    // 6. No payment record
    return jsonResponse({
      success: false,
      message: 'No payment record found for this booking.',
      paymentStatus: 'pending',
      retry: true
    }, 200, request);

  } catch (e) {
    console.error('❌ verify-payment fatal error:', e.message, e.stack);
    return jsonResponse({ error: 'Internal error: ' + e.message }, 500, request);
  }
}

// === Helper: ToyyibPay fallback ===
async function handleToyyibPay(booking, env, db, bookings, idx, request) {
  const secret = env.TOYYIBPAY_SECRET_KEY;
  if (!secret) {
    return jsonResponse({ error: 'ToyyibPay secret missing' }, 500, request);
  }
  if (booking.toyyibpay_billcode.startsWith('SIM-')) {
    bookings[idx].status = 'Paid - Awaiting Check-in';
    bookings[idx].paid_at = new Date().toISOString();
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings)).run();
    return jsonResponse({ success: true, booking: bookings[idx], paid: true }, 200, request);
  }

  const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${booking.toyyibpay_billcode}&userSecretKey=${secret}`;
  let billData;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'KundasangHomestay/1.0' } });
    const text = await res.text();
    billData = JSON.parse(text);
  } catch {
    return jsonResponse({
      success: false,
      message: 'Payment verification pending. Please wait.',
      retry: true,
      booking,
      paymentStatus: 'pending'
    }, 200, request);
  }

  if (billData && billData[0] && billData[0].billpaymentStatus === "1") {
    bookings[idx].status = 'Paid - Awaiting Check-in';
    bookings[idx].paid_at = new Date().toISOString();
    bookings[idx].toyyibpay_refno = billData[0].billpaymentTransactionId || '';
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings)).run();
    return jsonResponse({ success: true, booking: bookings[idx], paid: true }, 200, request);
  } else {
    const billStatus = billData && billData[0] ? billData[0].billpaymentStatus : null;
    if (billStatus === "3") {
      bookings[idx].status = 'Payment Failed';
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
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
        message: 'Payment not yet confirmed. Please wait.',
        retry: true,
        booking,
        paymentStatus: 'pending'
      }, 200, request);
    }
  }
}

// ===== Helper: JSON response =====
function jsonResponse(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
