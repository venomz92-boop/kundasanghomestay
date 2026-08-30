// /api/verify-payment.js – Debug version with detailed error logging
import { corsHeaders, getGuestSession, jsonResponse } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const { bookingId } = await request.json();
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    // 1. Auth
    let session;
    try {
      session = await getGuestSession(request, env);
      if (!session || session.type !== 'guest') {
        return jsonResponse({ error: 'Unauthorized' }, 401, request);
      }
    } catch (authErr) {
      console.error('Auth error:', authErr.message);
      return jsonResponse({ error: 'Authentication error: ' + authErr.message }, 500, request);
    }

    // 2. DB
    const db = env.DB;
    if (!db) {
      console.error('DB not configured');
      return jsonResponse({ error: 'DB not configured' }, 500, request);
    }

    // 3. Fetch booking
    let bookings = [];
    try {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
      if (r?.data) bookings = JSON.parse(r.data);
    } catch (dbErr) {
      console.error('DB read error:', dbErr.message);
      return jsonResponse({ error: 'Database read error: ' + dbErr.message }, 500, request);
    }

    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx === -1) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }
    const booking = bookings[idx];

    // 4. If already paid
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({ success: true, booking, paid: true }, 200, request);
    }

    // 5. CHIP handling
    if (booking.chip_purchase_id) {
      console.log(`🔍 Checking CHIP purchase: ${booking.chip_purchase_id}`);
      const chipApi = 'https://gate.chip-in.asia/api/v1/purchases/' + booking.chip_purchase_id;
      let response;
      try {
        response = await fetch(chipApi, {
          headers: { 'Authorization': `Bearer ${env.CHIP_SECRET_KEY}` }
        });
      } catch (fetchErr) {
        console.error('CHIP fetch error:', fetchErr.message);
        return jsonResponse({ error: 'Could not reach CHIP: ' + fetchErr.message }, 502, request);
      }

      let purchase;
      try {
        purchase = await response.json();
      } catch (parseErr) {
        console.error('CHIP response parse error:', parseErr.message);
        return jsonResponse({ error: 'Invalid CHIP response' }, 502, request);
      }

      if (!response.ok || !purchase.id) {
        console.error('CHIP error response:', purchase);
        return jsonResponse({ error: 'CHIP API error: ' + (purchase.message || 'unknown') }, 502, request);
      }

      console.log(`CHIP purchase status: ${purchase.status}`);

      if (purchase.status === 'completed' || purchase.status === 'paid') {
        // Update booking
        if (!booking.checkinCode) {
          booking.checkinCode = Math.floor(100000 + Math.random() * 900000).toString();
        }
        bookings[idx] = {
          ...booking,
          status: 'Paid - Awaiting Check-in',
          paid_at: new Date().toISOString(),
          chip_status: 'paid'
        };
        try {
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
        } catch (saveErr) {
          console.error('DB save error:', saveErr.message);
          return jsonResponse({ error: 'Failed to update booking: ' + saveErr.message }, 500, request);
        }

        return jsonResponse({ success: true, booking: bookings[idx], paid: true }, 200, request);
      } else {
        return jsonResponse({
          success: false,
          booking,
          paid: false,
          paymentStatus: purchase.status || 'pending',
          retry: true
        }, 200, request);
      }
    }

    // 6. Legacy ToyyibPay fallback
    if (booking.toyyibpay_billcode) {
      console.log(`🔄 Fallback to ToyyibPay for booking ${booking.id}`);
      return handleToyyibPay(booking, env, db, bookings, idx, request);
    }

    // 7. No payment provider
    return jsonResponse({
      success: false,
      message: 'No payment record found for this booking.',
      paymentStatus: 'pending',
      retry: true
    }, 200, request);

  } catch (e) {
    console.error('❌ verify-payment fatal error:', e.message, e.stack);
    return jsonResponse({ error: 'Internal server error: ' + e.message }, 500, request);
  }
}

// === Legacy ToyyibPay handler ===
async function handleToyyibPay(booking, env, db, bookings, idx, request) {
  const secret = env.TOYYIBPAY_SECRET_KEY;
  if (!secret) {
    return jsonResponse({ error: 'ToyyibPay secret missing' }, 500, request);
  }

  // Simulation
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

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
