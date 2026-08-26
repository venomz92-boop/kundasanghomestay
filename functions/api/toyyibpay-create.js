// /api/toyyibpay-create.js
import { corsHeaders, enforceHttps, getClientIP, getGuestSession, jsonResponse, logAction, getCSRFToken, validateCSRFToken } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    // ===== CSRF VALIDATION =====
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

    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx < 0) return jsonResponse({ error: 'Booking not found' }, 404, request);
    const booking = bookings[idx];

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

    const secret = env.TOYYIBPAY_SECRET_KEY, category = env.TOYYIBPAY_CATEGORY_CODE;
    const live = env.TOYYIBPAY_PAYMENT_ENABLED === 'true' && secret && category;
    if (!live) {
      return jsonResponse({
        error: 'Payment gateway is not enabled. Set TOYYIBPAY_PAYMENT_ENABLED=true and configure the ToyyibPay keys.'
      }, 503, request);
    }

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
      return jsonResponse({ error: 'ToyyibPay bill creation failed' }, 502, request);
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
    console.error('ToyyibPay create error:', e.message);
    return jsonResponse({ error: 'Payment setup failed' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
