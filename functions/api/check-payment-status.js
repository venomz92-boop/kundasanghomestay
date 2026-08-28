// /api/check-payment-status.js – with email on payment confirmation
import { corsHeaders, enforceHttps, getGuestSession, jsonResponse } from './_utils.js';

async function sendCheckinCodeEmail(to, guestName, bookingId, checkinCode, homestayName, checkin, checkout, env) {
  const html = `
    <h2>Hello ${guestName || 'Guest'},</h2>
    <p>Your booking <strong>${bookingId}</strong> at <strong>${homestayName}</strong> has been paid successfully.</p>
    <p><strong>Check‑in:</strong> ${checkin}</p>
    <p><strong>Check‑out:</strong> ${checkout}</p>
    <p style="font-size:24px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
      🏔️ Your 6‑digit check‑in code: <span style="color:#0F382E;">${checkinCode}</span>
    </p>
    <p>Please present this code to the host upon arrival.</p>
    <p>Thank you for booking with Kundasang Homestay!</p>
  `;
  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: to,
          subject: 'Your Check‑in Code – Payment Confirmed',
          html
        })
      });
      return r.ok;
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Your Check‑in Code – Payment Confirmed',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return r.ok;
    }
  } catch (e) {
    console.error('Email send error:', e.message);
  }
  return false;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    const { bookingId } = await request.json();
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server error' }, 500, request);
    }

    // 1. Get booking
    const result = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (result?.data) bookings = JSON.parse(result.data); } catch(_) {}
    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx < 0) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }
    const booking = bookings[idx];

    // 2. If already paid, return immediately
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({ success: true, status: booking.status, paid: true }, 200, request);
    }

    // 3. Get billcode
    const billcode = booking.toyyibpay_billcode;
    if (!billcode) {
      return jsonResponse({ error: 'No billcode found. Please try to pay again.' }, 404, request);
    }

    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      return jsonResponse({ error: 'Secret not configured' }, 500, request);
    }

    const apiBase = env.TOYYIBPAY_ENV === 'production' ? 'https://toyyibpay.com' : 'https://dev.toyyibpay.com';
    const url = `${apiBase}/index.php/api/getBillTransactions`;
    const form = new FormData();
    form.append('userSecretKey', secret);
    form.append('billCode', billcode);

    const response = await fetch(url, { method: 'POST', body: form });
    const data = await response.json().catch(() => null);

    if (!Array.isArray(data) || data.length === 0) {
      return jsonResponse({ error: 'No transactions found for this bill' }, 404, request);
    }

    // Find the latest successful transaction (status=1)
    const paidTransaction = data.find(t => String(t.billpaymentStatus) === '1');
    if (!paidTransaction) {
      return jsonResponse({ success: true, status: 'Pending Payment', paid: false }, 200, request);
    }

    // 4. Ensure checkinCode exists
    if (!booking.checkinCode) {
      booking.checkinCode = Math.floor(100000 + Math.random() * 900000).toString();
    }

    // 5. Update booking to paid
    bookings[idx] = {
      ...booking,
      status: 'Paid - Awaiting Check-in',
      paid_at: paidTransaction.billpaymentTransactionTime || new Date().toISOString(),
      toyyibpay_refno: paidTransaction.billpaymentRefNo || '',
      toyyibpay_status: '1',
      toyyibpay_amount: paidTransaction.billpaymentAmount || ''
    };

    await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    // 6. Send email with check‑in code
    await sendCheckinCodeEmail(
      booking.guestEmail,
      booking.guestName || 'Guest',
      booking.id,
      booking.checkinCode,
      booking.homestay || 'Kundasang Homestay',
      booking.checkin,
      booking.checkout,
      env
    );

    return jsonResponse({ success: true, status: 'Paid - Awaiting Check-in', paid: true }, 200, request);

  } catch (error) {
    console.error('Check status error:', error.message);
    return jsonResponse({ error: 'Failed to check status: ' + error.message }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
