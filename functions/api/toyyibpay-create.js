// /api/toyyibpay-create.js - with retry for booking read
import { corsHeaders, enforceHttps, getClientIP, getGuestSession, jsonResponse, logAction, getCSRFToken, validateCSRFToken } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    // CSRF Validation
    const csrf = getCSRFToken(request);
    if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) {
      return jsonResponse({ error: 'Invalid security token' }, 403, request);
    }

    const body = await request.json();
    const bookingId = String(body.bookingId || '');
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ===== RETRY LOOP TO HANDLE EVENTUAL CONSISTENCY =====
    let bookings = [];
    let idx = -1;
    let retries = 3;
    while (retries > 0 && idx === -1) {
      if (retries < 3) await new Promise(r => setTimeout(r, 300));
      const r2 = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
      try { bookings = JSON.parse(r2?.data || '[]'); } catch {}
      idx = bookings.findIndex(b => String(b.id) === bookingId);
      retries--;
    }
    if (idx < 0) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }
    const booking = bookings[idx];
    // ===== END RETRY =====

    if (String(booking.guestId) !== String(session.userId)) {
      return jsonResponse({ error: 'Unauthorized' }, 403, request);
    }
    if (booking.status !== 'Pending Payment') {
      return jsonResponse({ error: `Booking is not awaiting payment. Current status: ${booking.status}` }, 409, request);
    }
    if (booking.toyyibpay_billcode) {
      return jsonResponse({
        success: true,
        billCode: booking.toyyibpay_billcode,
        url: `https://toyyibpay.com/${booking.toyyibpay_billcode}`,
        bookingId,
        amount: Number(booking.total)
      }, 200, request);
    }

    // ---- Determine if we can use real ToyyibPay or fallback to simulation ----
    const secret = env.TOYYIBPAY_SECRET_KEY;
    const category = env.TOYYIBPAY_CATEGORY_CODE;
    const liveMode = env.TOYYIBPAY_PAYMENT_ENABLED === 'true' && secret && category;

    // If not live, we simulate the payment
    if (!liveMode) {
      console.log(`🔵 SIMULATION MODE: Creating fake bill for booking ${booking.id}`);
      // Generate a fake bill code
      const fakeBillCode = `SIM-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      
      // Update booking status to paid (simulated)
      bookings[idx] = {
        ...booking,
        toyyibpay_billcode: fakeBillCode,
        toyyibpay_created_at: new Date().toISOString(),
        paymentProvider: 'Simulation',
        status: 'Paid - Awaiting Check-in', // simulate paid immediately
        paid_at: new Date().toISOString(),
        simulation: true
      };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
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

      // Return a fake success with a redirect URL that will trigger the receipt modal
      const domain = env.PUBLIC_DOMAIN || new URL(request.url).origin;
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

    // ---- LIVE ToyyibPay flow ----
    const domain = env.PUBLIC_DOMAIN || new URL(request.url).origin;
    const form = new FormData();
    form.append('userSecretKey', secret);
    form.append('categoryCode', category);
    form.append('billName', String(booking.homestay).replace(/[^A-Za-z0-9 _]/g,'').slice(0,30) || 'Kundasang Homestay');
    form.append('billDescription', `Booking ${booking.id} ${booking.checkin} to ${booking.checkout}`.replace(/[^A-Za-z0-9 _]/g,' ').slice(0,100));
    form.append('billPriceSetting', '1');
    form.append('billPayorInfo', '1');
    form.append('billAmount', String(Math.round(Number(booking.total) * 100)));
    form.append('billReturnUrl', `${domain}/?booking=${encodeURIComponent(booking.id)}&payment_return=1`);
    form.append('billCallbackUrl', `${domain}/api/toyyibpay-webhook`);
    form.append('billExternalReferenceNo', booking.id);
    form.append('billTo', String(booking.guestName || 'Guest').slice(0,100));
    form.append('billEmail', String(booking.guestEmail || '').slice(0,120));
    form.append('billPhone', String(booking.guestPhone || '').replace(/[^0-9]/g,'').slice(-12));
    form.append('billSplitPayment', '0');
    form.append('billPaymentChannel', '0');
    form.append('billDisplayMerchant', '1');

    const res = await fetch('https://toyyibpay.com/index.php/api/createBill', { method: 'POST', body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.[0]?.BillCode) {
      return jsonResponse({ error: 'ToyyibPay bill creation failed. Please try again later.' }, 502, request);
    }
    const billCode = String(data[0].BillCode);
    bookings[idx] = {
      ...booking,
      toyyibpay_billcode: billCode,
      toyyibpay_created_at: new Date().toISOString(),
      paymentProvider: 'ToyyibPay'
    };
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
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

    return jsonResponse({
      success: true,
      url: `https://toyyibpay.com/${billCode}`,
      id: billCode,
      billCode,
      bookingId: booking.id,
      amount: Number(booking.total)
    }, 200, request);

  } catch (e) {
    console.error('ToyyibPay create error:', e.message, e.stack);
    return jsonResponse({ error: 'Payment setup failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
