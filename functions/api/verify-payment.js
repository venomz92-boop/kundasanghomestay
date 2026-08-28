// /api/verify-payment.js
import { corsHeaders } from './_utils.js';

export async function onRequestPost({ request, env }) {
  let responseStatus = 200;
  let responseBody = {};

  try {
    console.log('📡 verify-payment called (minimal functional)');

    // 1. Read and parse body
    const rawBody = await request.text();
    console.log('Raw body:', rawBody);
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      responseStatus = 400;
      responseBody = { error: 'Invalid JSON' };
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const bookingId = body.bookingId;
    if (!bookingId) {
      responseStatus = 400;
      responseBody = { error: 'Missing bookingId' };
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 2. Get database
    const db = env.DB;
    if (!db) {
      console.error('❌ DB not configured');
      responseStatus = 500;
      responseBody = { error: 'DB not configured' };
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 3. Fetch bookings
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try {
      bookings = JSON.parse(r?.data || '[]');
    } catch (e) {
      console.error('❌ Parse error:', e);
      responseStatus = 500;
      responseBody = { error: 'Data corruption' };
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    console.log(`📦 Found ${bookings.length} bookings`);

    // 4. Find the booking by ID (ignore guest session for now, but we'll later add session check)
    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx < 0) {
      responseStatus = 404;
      responseBody = { error: 'Booking not found' };
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const booking = bookings[idx];
    console.log(`✅ Found booking: ${booking.id}, status: ${booking.status}, billcode: ${booking.toyyibpay_billcode}`);

    // 5. If already paid, return success
    if (booking.status && booking.status.toLowerCase().includes('paid')) {
      responseBody = { success: true, booking, message: 'Already paid' };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 6. Simulation detection
    if (booking.toyyibpay_billcode && booking.toyyibpay_billcode.startsWith('SIM-')) {
      console.log(`✅ Simulation billcode detected, marking as paid`);
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      bookings[idx].simulation = true;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      responseBody = { success: true, booking: bookings[idx], message: 'Simulated payment confirmed' };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 7. If no billcode, return error
    if (!booking.toyyibpay_billcode) {
      responseStatus = 400;
      responseBody = { error: 'No billcode' };
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 8. Real ToyyibPay check (optional, but keep for completeness)
    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      console.error('❌ TOYYIBPAY_SECRET_KEY missing');
      responseStatus = 500;
      responseBody = { error: 'Payment gateway not configured' };
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${booking.toyyibpay_billcode}&userSecretKey=${secret}`;
    const res = await fetch(url);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('❌ Invalid JSON from ToyyibPay:', text);
      responseStatus = 502;
      responseBody = { error: 'Invalid response from payment gateway' };
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    if (data && data[0] && data[0].billpaymentStatus === "1") {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = data[0].billpaymentDatetime || new Date().toISOString();
      bookings[idx].toyyibpay_refno = data[0].billpaymentTransactionId || '';
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      responseBody = { success: true, booking: bookings[idx], message: 'Payment confirmed' };
    } else {
      responseBody = { success: false, message: 'Payment not yet confirmed' };
    }

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('💥 verify-payment fatal error:', e.message, e.stack);
    responseStatus = 500;
    responseBody = { error: 'Internal server error: ' + e.message };
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}

// GET for debugging
export async function onRequestGet({ request, env }) {
  try {
    const db = env.DB;
    const r = await db?.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    const count = r?.data ? JSON.parse(r.data).length : 0;
    return new Response(`verify-payment GET works. Bookings count: ${count}`, {
      headers: corsHeaders(request)
    });
  } catch (_) {
    return new Response('verify-payment GET works (DB not available)', {
      headers: corsHeaders(request)
    });
  }
}
