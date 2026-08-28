// /api/verify-payment.js
import { corsHeaders, getGuestSession, getClientIP } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    console.log('📡 verify-payment called');

    // 1. Parse body
    const rawBody = await request.text();
    console.log('Raw body:', rawBody);
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 2. Authenticate guest
    const session = await getGuestSession(request, env);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const bookingId = body.bookingId;
    if (!bookingId) {
      return new Response(JSON.stringify({ error: 'Missing bookingId' }), {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 3. Database
    const db = env.DB;
    if (!db) {
      console.error('❌ DB not configured');
      return new Response(JSON.stringify({ error: 'DB not configured' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 4. Fetch bookings
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try {
      bookings = JSON.parse(r?.data || '[]');
    } catch (e) {
      console.error('❌ Failed to parse bookings:', e);
      return new Response(JSON.stringify({ error: 'Data corruption' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 5. Find booking
    const idx = bookings.findIndex(b =>
      String(b.id) === bookingId &&
      String(b.guestId) === String(session.userId)
    );
    if (idx < 0) {
      return new Response(JSON.stringify({ error: 'Booking not found' }), {
        status: 404,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const booking = bookings[idx];

    // 6. Already paid?
    if (booking.status && booking.status.toLowerCase().includes('paid')) {
      return new Response(JSON.stringify({ success: true, booking, message: 'Already paid' }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 7. Simulation detection – if billcode starts with SIM-, mark as paid
    if (booking.toyyibpay_billcode && booking.toyyibpay_billcode.startsWith('SIM-')) {
      console.log(`✅ Simulation: marking ${bookingId} as paid`);
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      bookings[idx].simulation = true;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return new Response(JSON.stringify({ success: true, booking: bookings[idx], message: 'Simulated payment confirmed' }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 8. No billcode – error
    if (!booking.toyyibpay_billcode) {
      return new Response(JSON.stringify({ error: 'No billcode associated with this booking' }), {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 9. Call ToyyibPay
    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      console.error('❌ TOYYIBPAY_SECRET_KEY missing');
      return new Response(JSON.stringify({ error: 'Payment gateway not configured' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${booking.toyyibpay_billcode}&userSecretKey=${secret}`;
    console.log(`🔍 Verifying bill: ${booking.toyyibpay_billcode}`);
    const res = await fetch(url);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('❌ Invalid JSON from ToyyibPay:', text);
      return new Response(JSON.stringify({ error: 'Invalid response from payment gateway' }), {
        status: 502,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // 10. Check status
    if (data && data[0] && data[0].billpaymentStatus === "1") {
      // ✅ Paid
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = data[0].billpaymentDatetime || new Date().toISOString();
      bookings[idx].toyyibpay_refno = data[0].billpaymentTransactionId || '';
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return new Response(JSON.stringify({ success: true, booking: bookings[idx], message: 'Payment confirmed' }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    } else {
      // ⏳ Not yet paid
      return new Response(JSON.stringify({ success: false, message: 'Payment not yet confirmed' }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }
  } catch (e) {
    // 🚨 Catch any unhandled error and return it
    console.error('💥 verify-payment fatal error:', e.message, e.stack);
    return new Response(JSON.stringify({ error: 'Internal server error: ' + e.message }), {
      status: 500,
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
