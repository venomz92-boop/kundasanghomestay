// /api/verify-payment.js
import { corsHeaders, enforceHttps, getGuestSession, jsonResponse, logAction, getClientIP } from './_utils.js';

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    const url = new URL(request.url);
    const bookingId = url.searchParams.get('bookingId');
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx === -1) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }
    const booking = bookings[idx];

    // Only verify if booking is still pending
    if (booking.status !== 'Pending Payment') {
      return jsonResponse({
        success: true,
        status: booking.status,
        message: `Booking already has status: ${booking.status}`
      }, 200, request);
    }

    // Check if we have a billcode
    const billcode = booking.toyyibpay_billcode;
    if (!billcode) {
      return jsonResponse({ error: 'No billcode found for this booking' }, 400, request);
    }

    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      return jsonResponse({ error: 'ToyyibPay secret not configured' }, 500, request);
    }

    // Call ToyyibPay getBill API
    const apiUrl = env.TOYYIBPAY_SANDBOX === 'true'
      ? `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}`
      : `https://toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}`;

    const res = await fetch(apiUrl);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      return jsonResponse({ error: 'Invalid response from ToyyibPay' }, 502, request);
    }

    const bill = data[0];
    const statusCode = String(bill.billpaymentStatus || '');
    const isPaid = statusCode === '1';
    const isFailed = statusCode === '3';

    if (isPaid) {
      // Update booking to paid
      bookings[idx] = {
        ...booking,
        status: 'Paid - Awaiting Check-in',
        paid_at: bill.billpaymentDatetime || new Date().toISOString(),
        toyyibpay_refno: bill.billpaymentRefNo || '',
        toyyibpay_status: '1'
      };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      await logAction({
        db,
        action: 'payment_verified_via_api',
        admin: 'guest',
        details: `Booking ${bookingId} verified as paid via getBill API`,
        ip: getClientIP(request),
        userId: session.userId,
        homestayId: booking.homestayId
      });

      return jsonResponse({
        success: true,
        status: 'Paid - Awaiting Check-in',
        message: 'Payment confirmed. Your booking is now active.'
      }, 200, request);
    } else if (isFailed) {
      return jsonResponse({
        success: false,
        status: 'Payment Failed',
        message: 'Payment was not successful. Please try again.'
      }, 200, request);
    } else {
      return jsonResponse({
        success: false,
        status: 'Pending Payment',
        message: 'Payment still pending. Please complete the payment or contact support.'
      }, 200, request);
    }
  } catch (e) {
    console.error('Verify payment error:', e.message);
    return jsonResponse({ error: 'Verification failed: ' + e.message }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
