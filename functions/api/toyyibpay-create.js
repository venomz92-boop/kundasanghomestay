// /api/toyyibpay-create.js
import { corsHeaders, enforceHttps, getClientIP, getGuestSession, jsonResponse, logAction, getCSRFToken, validateCSRFToken } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // ---- 1. Authenticate guest ----
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    // ---- 2. CSRF validation ----
    const csrf = getCSRFToken(request);
    if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) {
      return jsonResponse({ error: 'Invalid security token' }, 403, request);
    }

    // ---- 3. Parse request ----
    const body = await request.json();
    const bookingId = String(body.bookingId || '');
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    // ---- 4. Connect to database ----
    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ---- 5. Retrieve booking with retry ----
    let bookings = [];
    let idx = -1;
    let retries = 3;
    while (retries > 0 && idx === -1) {
      if (retries < 3) await new Promise(r => setTimeout(r, 300));
      const result = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      try {
        bookings = JSON.parse(result?.data || '[]');
      } catch (_) {
        bookings = [];
      }
      idx = bookings.findIndex(b => String(b.id) === bookingId);
      retries--;
    }

    if (idx < 0) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }

    let booking = bookings[idx];

    // ---- 6. Validate booking ownership and status ----
    if (String(booking.guestId) !== String(session.userId)) {
      return jsonResponse({ error: 'Unauthorized' }, 403, request);
    }

    // Allow both 'Pending Payment' and 'Payment Failed' to create a bill
    if (!['Pending Payment', 'Payment Failed'].includes(booking.status)) {
      return jsonResponse({
        error: `Booking is not awaiting payment. Current status: ${booking.status}`
      }, 409, request);
    }

    // If booking is 'Payment Failed', reset status and clear old billcode
    if (booking.status === 'Payment Failed') {
      bookings[idx] = {
        ...booking,
        status: 'Pending Payment',
        toyyibpay_billcode: undefined,
        toyyibpay_created_at: undefined,
        paymentProvider: undefined,
        paid_at: undefined,
        simulation: undefined
      };
      booking = bookings[idx];
      // Save immediately so that we don't reuse a stale billcode
      await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
    }

    // ---- 7. Return existing bill if already created (and not failed) ----
    if (booking.toyyibpay_billcode && booking.status === 'Pending Payment') {
      const apiBase = env.TOYYIBPAY_ENV === 'production' ? 'https://toyyibpay.com' : 'https://dev.toyyibpay.com';
      return jsonResponse({
        success: true,
        billCode: booking.toyyibpay_billcode,
        url: `${apiBase}/${booking.toyyibpay_billcode}`,
        bookingId,
        amount: Number(booking.total)
      }, 200, request);
    }

    // ---- 8. Determine if live or simulation ----
    const secret = env.TOYYIBPAY_SECRET_KEY;
    const category = env.TOYYIBPAY_CATEGORY_CODE;
    const liveMode = env.TOYYIBPAY_PAYMENT_ENABLED === 'true' && secret && category;
    const domain = env.PUBLIC_DOMAIN || new URL(request.url).origin;
    const apiBase = env.TOYYIBPAY_ENV === 'production' ? 'https://toyyibpay.com' : 'https://dev.toyyibpay.com';

    // ---- 9. SIMULATION MODE ----
    if (!liveMode) {
      console.log(`🔵 SIMULATION: Creating fake bill for booking ${booking.id}`);
      const fakeBillCode = `SIM-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

      bookings[idx] = {
        ...booking,
        toyyibpay_billcode: fakeBillCode,
        toyyibpay_created_at: new Date().toISOString(),
        paymentProvider: 'Simulation',
        status: 'Paid - Awaiting Check-in',
        paid_at: new Date().toISOString(),
        simulation: true
      };

      await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      await logAction({
        db,
        action: 'toyyibpay_bill_created_simulation',
        admin: 'guest',
        details: `Simulated bill ${fakeBillCode} for ${booking.id}`,
        ip: getClientIP(request),
        userId: session.userId,
        homestayId: booking.homestayId
      });

      const returnUrl = `${domain}/?booking=${encodeURIComponent(booking.id)}&payment_return=1`;
      return jsonResponse({
        success: true,
        url: returnUrl,
        billCode: fakeBillCode,
        bookingId: booking.id,
        amount: Number(booking.total),
        simulation: true,
        message: 'Simulated payment successful. You will be redirected to the confirmation page.'
      }, 200, request);
    }

    // ---- 10. LIVE TOYYIBPAY - Create bill ----
    console.log(`🟢 LIVE: Creating ToyyibPay bill for booking ${booking.id}`);

    const form = new FormData();
    form.append('userSecretKey', secret);
    form.append('categoryCode', category);
    form.append('billName', String(booking.homestay || 'Kundasang Homestay').replace(/[^A-Za-z0-9 _]/g, '').slice(0, 30));
    form.append('billDescription', `Booking ${booking.id} ${booking.checkin} to ${booking.checkout}`.replace(/[^A-Za-z0-9 _]/g, ' ').slice(0, 100));
    form.append('billPriceSetting', '1'); // Fixed amount
    form.append('billPayorInfo', '1'); // Collect payer info
    form.append('billAmount', String(Math.round(Number(booking.total) * 100))); // Amount in cents
    form.append('billReturnUrl', `${domain}/?booking=${encodeURIComponent(booking.id)}&payment_return=1`);
    form.append('billCallbackUrl', `${domain}/api/toyyibpay-webhook`);
    form.append('billExternalReferenceNo', booking.id);
    form.append('billTo', String(booking.guestName || 'Guest').slice(0, 100));
    form.append('billEmail', String(booking.guestEmail || '').slice(0, 120));
    form.append('billPhone', String(booking.guestPhone || '').replace(/[^0-9]/g, '').slice(-12));
    form.append('billSplitPayment', '0');
    form.append('billPaymentChannel', env.TOYYIBPAY_PAYMENT_CHANNEL || '0');
    form.append('billDisplayMerchant', '1');

    // ---- 11. Send request to ToyyibPay ----
    const response = await fetch(`${apiBase}/index.php/api/createBill`, {
      method: 'POST',
      body: form
    });

    const responseData = await response.json().catch(() => null);

    if (!response.ok || !responseData?.[0]?.BillCode) {
      console.error('❌ ToyyibPay bill creation failed:', responseData);
      return jsonResponse({
        error: 'ToyyibPay bill creation failed. Please try again later.'
      }, 502, request);
    }

    const billCode = String(responseData[0].BillCode);
    console.log(`✅ Bill created: ${billCode} for booking ${booking.id}`);

    // ---- 12. Update booking with bill code ----
    bookings[idx] = {
      ...booking,
      toyyibpay_billcode: billCode,
      toyyibpay_created_at: new Date().toISOString(),
      paymentProvider: 'ToyyibPay'
    };

    await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    await logAction({
      db,
      action: 'toyyibpay_bill_created',
      admin: 'guest',
      details: `Bill ${billCode} created for ${booking.id}`,
      ip: getClientIP(request),
      userId: session.userId,
      homestayId: booking.homestayId
    });

    // ---- 13. Return payment URL ----
    return jsonResponse({
      success: true,
      url: `${apiBase}/${billCode}`,
      billCode: billCode,
      bookingId: booking.id,
      amount: Number(booking.total)
    }, 200, request);

  } catch (error) {
    console.error('❌ ToyyibPay create error:', error.message, error.stack);
    return jsonResponse({
      error: 'Payment setup failed. Please try again later.'
    }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
