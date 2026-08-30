// /api/verify-payment.js – Full debug with error details
export async function onRequestPost({ request, env }) {
  let response = null;
  try {
    const { bookingId } = await request.json();
    if (!bookingId) {
      return new Response(JSON.stringify({ error: 'Missing bookingId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: 'DB not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Read booking
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    if (r?.data) {
      try { bookings = JSON.parse(r.data); } catch (_) {}
    }
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx === -1) {
      return new Response(JSON.stringify({ error: 'Booking not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const booking = bookings[idx];

    // Already paid?
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return new Response(JSON.stringify({ success: true, booking, paid: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Check Chip if we have purchase_id
    if (!booking.chip_purchase_id) {
      return new Response(JSON.stringify({
        success: false,
        message: 'No Chip purchase found for this booking.',
        paymentStatus: 'pending',
        retry: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 1. Get Chip secret – if missing, return error
    const chipSecret = env.CHIP_SECRET_KEY;
    if (!chipSecret) {
      return new Response(JSON.stringify({
        error: 'CHIP_SECRET_KEY not configured in environment',
        envKeys: Object.keys(env)  // 👈 Shows what keys are available (safe)
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 2. Call Chip API
    const chipApi = 'https://gate.chip-in.asia/api/v1/purchases/' + booking.chip_purchase_id;
    let resp;
    try {
      resp = await fetch(chipApi, { headers: { 'Authorization': 'Bearer ' + chipSecret } });
    } catch (fetchErr) {
      return new Response(JSON.stringify({
        error: 'Chip API fetch failed: ' + fetchErr.message,
        stack: fetchErr.stack
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 3. Parse response
    let purchase;
    try {
      purchase = await resp.json();
    } catch (parseErr) {
      return new Response(JSON.stringify({
        error: 'Invalid Chip response: ' + parseErr.message,
        statusCode: resp.status,
        statusText: resp.statusText
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (!resp.ok) {
      return new Response(JSON.stringify({
        error: 'Chip API error',
        statusCode: resp.status,
        chipResponse: purchase
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 4. If status is 'completed' or 'paid', update
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
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
      return new Response(JSON.stringify({ success: true, booking: bookings[idx], paid: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } else {
      return new Response(JSON.stringify({
        success: false,
        booking,
        paid: false,
        paymentStatus: purchase.status || 'pending',
        chipResponse: purchase,
        retry: true
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

  } catch (e) {
    console.error('❌ verify-payment fatal error:', e.message, e.stack);
    return new Response(JSON.stringify({
      error: 'Internal error: ' + e.message,
      stack: e.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}
