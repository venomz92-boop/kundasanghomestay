// /api/check-payment-status.js – CHIP-only payment status check + email on confirmation
import {
  corsHeaders,
  enforceHttps,
  getGuestSession,
  jsonResponse
} from './_utils.js';

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

    // 1. Load booking
    const result = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (result?.data) bookings = JSON.parse(result.data); } catch(_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx < 0) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }
    const booking = bookings[idx];

    // Ownership check
    if (String(booking.guestId) !== String(session.userId)) {
      return jsonResponse({ error: 'Unauthorized' }, 403, request);
    }

    // 2. Already paid — return immediately
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({ success: true, status: booking.status, paid: true }, 200, request);
    }

    // 3. CHIP purchase id required
    const purchaseId = booking.chip_purchase_id;
    if (!purchaseId) {
      return jsonResponse({ error: 'No CHIP purchase found. Please try to pay again.' }, 404, request);
    }

    const chipSecret = env.CHIP_SECRET_KEY;
    if (!chipSecret) {
      return jsonResponse({ error: 'Payment gateway not configured' }, 500, request);
    }

    // 4. Query CHIP purchase
    let purchase = null;
    try {
      const resp = await fetch(`https://gate.chip-in.asia/api/v1/purchases/${purchaseId}/`, {
        headers: { 'Authorization': `Bearer ${chipSecret}` }
      });
      if (!resp.ok) {
        return jsonResponse({ error: 'Could not fetch purchase status' }, 502, request);
      }
      purchase = await resp.json();
    } catch (e) {
      return jsonResponse({ error: 'Payment gateway unreachable' }, 502, request);
    }

    const chipStatus = purchase?.status;

    // 5. Not paid yet
    if (chipStatus !== 'paid' && chipStatus !== 'completed') {
      const isFailed = ['cancelled', 'expired', 'failed'].includes(chipStatus);
      return jsonResponse({
        success: true,
        status: isFailed ? 'Payment Failed' : 'Pending Payment',
        paid: false,
        chipStatus: chipStatus || 'unknown'
      }, 200, request);
    }

    // 6. Paid — generate code if needed
    const codeWasMissing = !booking.checkinCode;
    if (codeWasMissing) {
      booking.checkinCode = Math.floor(100000 + Math.random() * 900000).toString();
    }

    // 7. Update booking
    bookings[idx] = {
      ...booking,
      status: 'Paid - Awaiting Check-in',
      paid_at: booking.paid_at || new Date().toISOString(),
      chip_status: 'paid'
    };

    await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    // 8. Send email only if we just generated the code
    if (codeWasMissing) {
      try {
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
      } catch (mailErr) {
        console.error('Check-in email failed:', mailErr.message);
      }
    }

    return jsonResponse({ success: true, status: 'Paid - Awaiting Check-in', paid: true }, 200, request);

  } catch (error) {
    console.error('Check status error:', error.message);
    return jsonResponse({ error: 'Failed to check status. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
