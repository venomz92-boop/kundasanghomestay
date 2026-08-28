// /api/toyyibpay-create.js
import { corsHeaders, getGuestSession, jsonResponse, logAction, getClientIP } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    console.log('📡 ToyyibPay create called');

    const session = await getGuestSession(request, env);
    if (!session) return jsonResponse({ error: 'Unauthorized' }, 401, request);

    const { bookingId } = await request.json();
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

    // Retrieve booking
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
    const idx = bookings.findIndex(b => String(b.id) === bookingId && String(b.guestId) === String(session.userId));
    if (idx < 0) return jsonResponse({ error: 'Booking not found' }, 404, request);

    const booking = bookings[idx];
    if (booking.status !== 'Pending Payment') {
      return jsonResponse({ error: 'Booking not awaiting payment' }, 409, request);
    }

    // ---- Check if bill already exists ----
    if (booking.toyyibpay_billcode) {
      return jsonResponse({
        success: true,
        billCode: booking.toyyibpay_billcode,
        url: `https://dev.toyyibpay.com/${booking.toyyibpay_billcode}`,
        bookingId,
        amount: Number(booking.total)
      }, 200, request);
    }

    // ---- Get credentials ----
    const secret = env.TOYYIBPAY_SECRET_KEY;
    const category = env.TOYYIBPAY_CATEGORY_CODE;
    const liveMode = env.TOYYIBPAY_PAYMENT_ENABLED === 'true' && secret && category;

    console.log(`🔐 liveMode: ${liveMode}, secret exists: ${!!secret}, category: ${category}`);

    // ---- Simulation fallback ----
    if (!liveMode) {
      console.log('🔵 SIMULATION: Creating fake bill');
      const fakeBillCode = `SIM-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      bookings[idx] = { ...booking, toyyibpay_billcode: fakeBillCode, simulation: true, status: 'Paid - Awaiting Check-in', paid_at: new Date().toISOString() };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return jsonResponse({
        success: true,
        url: `${env.PUBLIC_DOMAIN}/?booking=${booking.id}&payment_return=1`,
        billCode: fakeBillCode,
        bookingId: booking.id,
        amount: Number(booking.total),
        simulation: true
      }, 200, request);
    }

    // ---- Real ToyyibPay bill creation ----
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

    console.log('📤 Sending bill creation request to ToyyibPay');

    const res = await fetch('https://dev.toyyibpay.com/index.php/api/createBill', { method: 'POST', body: form });
    const responseText = await res.text();
    console.log('📥 ToyyibPay response status:', res.status);
    console.log('📥 ToyyibPay response text:', responseText);

    let data;
    try { data = JSON.parse(responseText); } catch (e) {
      console.error('❌ Failed to parse response:', responseText);
      return jsonResponse({ error: 'Invalid response from ToyyibPay: ' + responseText.slice(0, 200) }, 502, request);
    }

    if (!res.ok || !data?.[0]?.BillCode) {
      console.error('❌ Bill creation failed:', data);
      return jsonResponse({
        error: 'Bill creation failed',
        details: data,
        status: res.status
      }, 502, request);
    }

    const billCode = String(data[0].BillCode);
    console.log(`✅ Bill created: ${billCode}`);

    bookings[idx] = {
      ...booking,
      toyyibpay_billcode: billCode,
      toyyibpay_created_at: new Date().toISOString(),
      paymentProvider: 'ToyyibPay'
    };
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings)).run();

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
      url: `https://dev.toyyibpay.com/${billCode}`,
      billCode,
      bookingId: booking.id,
      amount: Number(booking.total)
    }, 200, request);

  } catch (e) {
    console.error('❌ ToyyibPay create error:', e.message, e.stack);
    return jsonResponse({ error: 'Payment setup failed: ' + e.message }, 500, request);
  }
}
