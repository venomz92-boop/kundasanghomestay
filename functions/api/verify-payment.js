// /api/verify-payment.js – No external imports, standalone version
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const bookingId = body.bookingId;
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'DB not configured' }, 500);
    }

    // Read booking
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    if (r?.data) {
      try { bookings = JSON.parse(r.data); } catch (_) {}
    }
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx === -1) {
      return jsonResponse({ error: 'Booking not found' }, 404);
    }
    const booking = bookings[idx];

    // Already paid?
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({ success: true, booking, paid: true }, 200);
    }

    // 1. CHIP purchase check
    if (booking.chip_purchase_id) {
      const secret = env.CHIP_SECRET_KEY;
      if (!secret) {
        return jsonResponse({ error: 'CHIP_SECRET_KEY not set' }, 500);
      }
      const url = 'https://gate.chip-in.asia/api/v1/purchases/' + booking.chip_purchase_id;
      let resp;
      try {
        resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + secret } });
      } catch (e) {
        console.error('Fetch error:', e.message);
        return jsonResponse({ error: 'CHIP API unreachable' }, 502);
      }
      let purchase;
      try {
        purchase = await resp.json();
      } catch (e) {
        console.error('Parse error:', e.message);
        return jsonResponse({ error: 'Invalid CHIP response' }, 502);
      }
      if (!resp.ok) {
        console.error('CHIP error:', purchase);
        return jsonResponse({ error: 'CHIP API error' }, 502);
      }

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
        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_bookings', JSON.stringify(bookings))
          .run();
        return jsonResponse({ success: true, booking: bookings[idx], paid: true }, 200);
      } else {
        return jsonResponse({
          success: false,
          booking,
          paid: false,
          paymentStatus: purchase.status || 'pending',
          retry: true
        }, 200);
      }
    }

    // 2. Legacy ToyyibPay fallback
    if (booking.toyyibpay_billcode) {
      return handleToyyibPay(booking, env, db, bookings, idx);
    }

    // 3. No payment record
    return jsonResponse({
      success: false,
      message: 'No payment record found for this booking.',
      paymentStatus: 'pending',
      retry: true
    }, 200);

  } catch (e) {
    console.error('❌ verify-payment fatal error:', e.message, e.stack);
    return jsonResponse({ error: 'Internal server error: ' + e.message }, 500);
  }
}

// ===== Helper: ToyyibPay fallback =====
async function handleToyyibPay(booking, env, db, bookings, idx) {
  const secret = env.TOYYIBPAY_SECRET_KEY;
  if (!secret) {
    return jsonResponse({ error: 'ToyyibPay secret missing' }, 500);
  }
  if (booking.toyyibpay_billcode.startsWith('SIM-')) {
    bookings[idx].status = 'Paid - Awaiting Check-in';
    bookings[idx].paid_at = new Date().toISOString();
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings)).run();
    return jsonResponse({ success: true, booking: bookings[idx], paid: true }, 200);
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
    }, 200);
  }

  if (billData && billData[0] && billData[0].billpaymentStatus === "1") {
    bookings[idx].status = 'Paid - Awaiting Check-in';
    bookings[idx].paid_at = new Date().toISOString();
    bookings[idx].toyyibpay_refno = billData[0].billpaymentTransactionId || '';
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings)).run();
    return jsonResponse({ success: true, booking: bookings[idx], paid: true }, 200);
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
      }, 200);
    } else {
      return jsonResponse({
        success: false,
        message: 'Payment not yet confirmed. Please wait.',
        retry: true,
        booking,
        paymentStatus: 'pending'
      }, 200);
    }
  }
}

// ===== JSON response helper (inline CORS) =====
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://kundasanghomestay.my',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Owner-Authorization, X-CSRF-Token',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: {
    'Access-Control-Allow-Origin': 'https://kundasanghomestay.my',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Owner-Authorization, X-CSRF-Token',
    'Access-Control-Max-Age': '86400'
  }});
}
