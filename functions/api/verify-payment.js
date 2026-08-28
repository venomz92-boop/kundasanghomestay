import { corsHeaders, getGuestSession, jsonResponse, logAction } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const session = await getGuestSession(request, env);
  if (!session || session.type !== 'guest') {
    return jsonResponse({ error: 'Unauthorized' }, 401, request);
  }

  const { bookingId } = await request.json();
  if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'Server error' }, 500, request);

  // Retrieve booking
  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
  const idx = bookings.findIndex(b => String(b.id) === String(bookingId) && String(b.guestId) === String(session.userId));
  if (idx === -1) return jsonResponse({ error: 'Booking not found' }, 404, request);

  const booking = bookings[idx];

  // If already paid, return success
  if (booking.status && booking.status.toLowerCase().includes('paid')) {
    return jsonResponse({ success: true, booking, message: 'Already paid' }, 200, request);
  }

  // If no billcode, cannot verify
  if (!booking.toyyibpay_billcode) {
    return jsonResponse({ error: 'No billcode associated with this booking' }, 400, request);
  }

  // Call ToyyibPay to check bill status
  const secret = env.TOYYIBPAY_SECRET_KEY;
  if (!secret) return jsonResponse({ error: 'Server configuration missing' }, 500, request);

  const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${booking.toyyibpay_billcode}&userSecretKey=${secret}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data && data[0] && data[0].billpaymentStatus === "1") {
    // Mark as paid
    bookings[idx].status = 'Paid - Awaiting Check-in';
    bookings[idx].paid_at = data[0].billpaymentDatetime || new Date().toISOString();
    bookings[idx].toyyibpay_refno = data[0].billpaymentTransactionId || '';
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_bookings', JSON.stringify(bookings)).run();

    await logAction({
      db,
      action: 'payment_verified_manually',
      admin: 'guest',
      details: `Payment verified for ${bookingId} via fallback`,
      ip: getClientIP(request),
      userId: session.userId
    });

    return jsonResponse({ success: true, booking: bookings[idx], message: 'Payment confirmed' }, 200, request);
  } else {
    return jsonResponse({ success: false, message: 'Payment not yet confirmed' }, 200, request);
  }
}
