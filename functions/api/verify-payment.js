// /api/verify-payment.js – Secured with authentication
import { corsHeaders, getClientIP, logAction, enforceHttps, getGuestSession, jsonResponse, checkRateLimit, recordRateLimit, withLock, finalizePaidBooking } from './_utils.js';

async function sendCheckinEmail(booking, env) {
  const receiptNo = `RCP-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${booking.id.slice(-6)}`;
  const base = Number(booking.base || 0);
  const fee = Number(booking.fee || 0);
  const gatewayFee = Number(booking.gatewayFee || 0);
  const total = Number(booking.total || 0);

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f5f0; padding: 20px; border-radius: 16px;">
      <div style="background: #ffffff; padding: 30px; border-radius: 16px; border: 1px solid #e5e7eb;">
        <div style="text-align: center; border-bottom: 2px solid #0F382E; padding-bottom: 16px; margin-bottom: 20px;">
          <div style="font-size: 24px; font-weight: 800; color: #0F382E;">Kundasang Homestay</div>
          <div style="font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px;">Official Receipt</div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 12px;">
          <div><strong>Receipt No.:</strong> ${receiptNo}</div>
          <div><strong>Booking ID:</strong> ${booking.id}</div>
        </div>
        <div style="font-size: 13px; margin-bottom: 16px; border-bottom: 1px dashed #d1d5db; padding-bottom: 12px;">
          <div><strong>Guest:</strong> ${booking.guestName || 'Guest'}</div>
          <div><strong>Homestay:</strong> ${booking.homestay}</div>
          <div><strong>Check‑in:</strong> ${booking.checkin} &nbsp;|&nbsp; <strong>Check‑out:</strong> ${booking.checkout} &nbsp;|&nbsp; <strong>Nights:</strong> ${booking.nights}</div>
        </div>
        <div style="font-size: 13px; margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; padding: 4px 0;">
            <span>Base price (RM ${(base / (booking.nights || 1)).toFixed(2)} × ${booking.nights} nights)</span>
            <span>RM ${base.toFixed(2)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #4b5563;">
            <span>Service Fee</span>
            <span>RM ${fee.toFixed(2)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #4b5563;">
            <span>Gateway fee</span>
            <span>RM ${gatewayFee.toFixed(2)}</span>
          </div>
        </div>
        <div style="border-top: 2px solid #0F382E; padding-top: 12px; font-size: 16px; font-weight: 700; color: #0F382E; display: flex; justify-content: space-between; margin-bottom: 16px;">
          <span>Total paid</span>
          <span>RM ${total.toFixed(2)}</span>
        </div>
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; text-align: center; margin-bottom: 16px;">
          <div style="font-size: 20px; font-weight: 700; color: #0F382E;">
            🏔️ Your 6‑digit check‑in code: <span style="color: #0F382E;">${booking.checkinCode}</span>
          </div>
          <div style="font-size: 12px; color: #166534; margin-top: 4px;">Please keep this code safe. You will need to share it with the host upon arrival.</div>
        </div>
        <div style="text-align: center; font-size: 11px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 12px;">
          Payment via CHIP FPX • Status: Completed<br>
          © ${new Date().getFullYear()} Kundasang Homestay
        </div>
      </div>
    </div>
  `;

  let emailSent = false;
  let emailError = null;

  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: booking.guestEmail,
          subject: `Your Receipt ${receiptNo} – Check‑in Code`,
          html: emailHtml
        })
      });
      emailSent = res.ok;
      if (!emailSent) emailError = 'Resend API error';
    } catch (e) {
      emailError = e.message;
    }
  } else if (env.SENDGRID_API_KEY) {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: booking.guestEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: `Your Receipt ${receiptNo} – Check‑in Code`,
          content: [{ type: 'text/html', value: emailHtml }]
        })
      });
      emailSent = res.ok;
      if (!emailSent) emailError = 'SendGrid API error';
    } catch (e) {
      emailError = e.message;
    }
  } else {
    emailError = 'No email API key configured';
  }

  return { emailSent, emailError };
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // ===== 1. AUTHENTICATION REQUIRED =====
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    // ===== 2. Rate limiting =====
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    const rateOk = await checkRateLimit(db, clientIP, 'verify_payment', 10, 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many requests. Please wait a moment.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, 'verify_payment');

    const { bookingId } = await request.json();
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx === -1) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }

    const booking = bookings[idx];

    // ===== 3. VERIFY OWNERSHIP =====
    if (String(booking.guestId) !== String(session.userId)) {
      await logAction({
        db,
        action: 'unauthorized_payment_check',
        admin: 'guest',
        details: `Guest ${session.userId} tried to check booking ${bookingId} belonging to ${booking.guestId}`,
        ip: clientIP,
        userId: session.userId,
        homestayId: booking.homestayId
      });
      return jsonResponse({ error: 'Unauthorized' }, 403, request);
    }

    const status = booking.status || 'Pending Payment';

    // ===== 4. ALREADY PAID =====
    if (['Paid - Awaiting Check-in', 'Completed'].includes(status)) {
      const { checkinCode, ...safeBooking } = booking;
      return jsonResponse({ success: true, booking: safeBooking, paid: true }, 200, request);
    }

    // ===== 5. CHIP CHECK (if purchase ID exists) =====
    if (booking.chip_purchase_id) {
      const chipSecret = env.CHIP_SECRET_KEY;
      if (!chipSecret) {
        const { checkinCode, ...safeBooking } = booking;
        return jsonResponse({
          success: false,
          message: 'Payment gateway not fully configured',
          retry: true,
          booking: safeBooking,
          paymentStatus: 'pending'
        }, 200, request);
      }

      try {
        const resp = await fetch(`https://gate.chip-in.asia/api/v1/purchases/${booking.chip_purchase_id}/`, {
          headers: { 'Authorization': `Bearer ${chipSecret}` }
        });
        if (!resp.ok) {
          const { checkinCode, ...safeBooking } = booking;
          return jsonResponse({
            success: false,
            message: 'Could not fetch purchase status',
            retry: true,
            booking: safeBooking,
            paymentStatus: 'pending'
          }, 200, request);
        }
        const purchase = await resp.json();
        const purchaseStatus = purchase.status;

                if (purchaseStatus === 'completed' || purchaseStatus === 'paid') {
          let finalizeResult;
          try {
            finalizeResult = await withLock(db, `paid-${booking.id}`, async (db) => {
              return await finalizePaidBooking(db, booking.id);
            }, 10000);
          } catch (lockErr) {
            if (lockErr.message && lockErr.message.includes('in progress')) {
              await new Promise(r => setTimeout(r, 800));
              const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
              let bb = [];
              try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
              const cur = bb.find(b => String(b.id) === String(booking.id));
              if (cur && (cur.status === 'Paid - Awaiting Check-in' || String(cur.status).startsWith('Completed'))) {
                const { checkinCode, ...safeBooking } = cur;
                return jsonResponse({ success: true, booking: safeBooking, paid: true }, 200, request);
              }
            }
            throw lockErr;
          }

          if (finalizeResult.error) {
            return jsonResponse({ error: finalizeResult.error }, 500, request);
          }

          // If WE finalized it and code was newly generated, send email.
          if (finalizeResult.finalized && finalizeResult.codeWasMissing) {
            await sendCheckinEmail(finalizeResult.booking, env);
          }

          const { checkinCode, ...safeBooking } = finalizeResult.booking;
          return jsonResponse({ success: true, booking: safeBooking, paid: true }, 200, request);
        } else if (purchaseStatus === 'cancelled' || purchaseStatus === 'expired' || purchaseStatus === 'failed') {
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
          const { checkinCode, ...safeBooking } = bookings[idx];
          return jsonResponse({
            success: false,
            message: 'Payment failed or expired.',
            retry: true,
            booking: safeBooking,
            paymentStatus: 'failed'
          }, 200, request);
        } else {
          const { checkinCode, ...safeBooking } = booking;
          return jsonResponse({
            success: false,
            message: 'Payment not yet confirmed.',
            retry: true,
            booking: safeBooking,
            paymentStatus: 'pending'
          }, 200, request);
        }
      } catch (e) {
        console.error('CHIP check error:', e.message);
        const { checkinCode, ...safeBooking } = booking;
        return jsonResponse({
          success: false,
          message: 'Error checking payment status',
          retry: true,
          booking: safeBooking,
          paymentStatus: 'pending'
        }, 200, request);
      }
    }

    // ===== 6. FALLBACK =====
    const { checkinCode, ...safeBooking } = booking;
    return jsonResponse({
      success: false,
      message: 'No payment provider found for this booking.',
      retry: true,
      booking: safeBooking,
      paymentStatus: 'pending'
    }, 200, request);

  } catch (e) {
    console.error('verify-payment error:', e.message);
    return jsonResponse({ error: 'Internal server error. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
