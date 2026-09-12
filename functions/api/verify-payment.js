// /api/verify-payment.js — Plain English: when the guest comes back from
// the CHIP payment page, this file asks CHIP whether the payment actually
// went through and, if so, marks the booking as paid. Changes:
// (1) All booking writes now happen inside the ONE shared global lock so
//     this can never race with the webhook, chip-create, or a host
//     cancellation.
// (2) When a booking is already refunded or cancelled, we no longer
//     pretend the payment "failed" — we say "refunded" or "cancelled"
//     so the guest page shows the truth.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  getGuestSession,
  jsonResponse,
  checkRateLimit,
  recordRateLimit,
  withLock,
  finalizePaidBooking
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';

// ============================================================
// Auto-refund helper for a cancelled booking whose CHIP payment
// settled late.
//
// IMPORTANT: the CALLER must already hold the bookings lock
// (C4). We do NOT take our own lock here so verify-payment,
// chip-create, and chip-webhook all serialize on the SAME key.
// ============================================================
async function tryAutoRefundLatePaymentLocked(db, bookingId, env) {
  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
  const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
  if (idx === -1) return { error: 'Booking not found' };
  const b = bookings[idx];

  if (b.chip_refund_id) {
    return { alreadyRefunded: true, refundId: b.chip_refund_id };
  }
  if (!b.chip_purchase_id) {
    return { error: 'No chip_purchase_id to refund' };
  }

  const secret = env.CHIP_SECRET_KEY;
  if (!secret) return { error: 'CHIP_SECRET_KEY missing' };

  const refundAmountCents = Math.round(Number(b.total) * 100);

  try {
    const res = await fetch(
      `https://gate.chip-in.asia/api/v1/purchases/${b.chip_purchase_id}/refund/`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secret}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ amount: refundAmountCents })
      }
    );
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }

    if (!res.ok || !data || !data.id) {
      return { error: `CHIP refund failed: ${data?.error || 'unknown'}` };
    }

    const isPending = data.status === 'pending_refund';

    bookings[idx].status = isPending ? 'Refund Pending - Awaiting CHIP' : 'Refunded - Late Payment';
    bookings[idx].chip_refund_id = data.id;
    bookings[idx].refunded_at = new Date().toISOString();
    bookings[idx].refund_amount = Number(b.total) || 0;
    bookings[idx].late_payment_refund = true;
    if (isPending) bookings[idx].refund_pending = true;

    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    return { success: true, refundId: data.id, pending: isPending };
  } catch (e) {
    return { error: `Refund network error: ${e.message}` };
  }
}

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
          <div><strong>Check-in:</strong> ${booking.checkin} &nbsp;|&nbsp; <strong>Check-out:</strong> ${booking.checkout} &nbsp;|&nbsp; <strong>Nights:</strong> ${booking.nights}</div>
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
            🏔️ Your 6-digit check-in code: <span style="color: #0F382E;">${booking.checkinCode}</span>
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
          subject: `Your Receipt ${receiptNo} – Check-in Code`,
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
          subject: `Your Receipt ${receiptNo} – Check-in Code`,
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

    // Unlocked read for ownership + initial state check.
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

    const status = String(booking.status || 'Pending Payment');

    // ===== 4a. ALREADY PAID (or already terminal success) =====
    if (status === 'Paid - Awaiting Check-in' || status.startsWith('Completed')) {
      const { checkinCode, ...safeBooking } = booking;
      return jsonResponse({ success: true, booking: safeBooking, paid: true }, 200, request);
    }

    // ===== 4b. H4 FIX: refunded / cancelled are NOT "failed" =====
    // Return a specific paymentStatus so the UI can render accurately.
    if (/refunded/i.test(status)) {
      const { checkinCode, ...safeBooking } = booking;
      return jsonResponse({
        success: false,
        message: `This booking has been refunded (${status}).`,
        retry: false,
        booking: safeBooking,
        paymentStatus: 'refunded'
      }, 200, request);
    }
    if (/cancelled/i.test(status)) {
      const { checkinCode, ...safeBooking } = booking;
      return jsonResponse({
        success: false,
        message: `This booking was ${status}.`,
        retry: false,
        booking: safeBooking,
        paymentStatus: 'cancelled'
      }, 200, request);
    }
    if (/expired/i.test(status)) {
      const { checkinCode, ...safeBooking } = booking;
      return jsonResponse({
        success: false,
        message: `This booking has expired.`,
        retry: false,
        booking: safeBooking,
        paymentStatus: 'expired'
      }, 200, request);
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
          // C4: canonical lock. Finalize + potential auto-refund both
          // happen inside this one lock block.
          let lockResult;
          try {
            lockResult = await withLock(db, BOOKINGS_LOCK, async (db) => {
              const finalizeResult = await finalizePaidBooking(db, booking.id);
              if (finalizeResult.error) return { finalizeResult };
              if (finalizeResult.refuseFinalize) {
                const refundResult = await tryAutoRefundLatePaymentLocked(db, booking.id, env);
                return { finalizeResult, refundResult };
              }
              return { finalizeResult };
            }, 60000);
          } catch (lockErr) {
            if (lockErr.message && lockErr.message.includes('in progress')) {
              // Another confirmation path is finalizing. Give it a moment
              // and answer from the fresh state.
              await new Promise(res => setTimeout(res, 800));
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

          const finalizeResult = lockResult.finalizeResult;

          if (finalizeResult.error) {
            return jsonResponse({ error: finalizeResult.error }, 500, request);
          }

          // Refuse to finalize = booking was cancelled before payment
          // settled. Auto-refund already ran inside the lock.
          if (finalizeResult.refuseFinalize) {
            const refundResult = lockResult.refundResult || { error: 'refund not attempted' };
            await logAction({
              db,
              action: refundResult.success ? 'late_payment_auto_refunded' : 'late_payment_refund_failed',
              admin: 'system',
              details: `Refused to finalize ${booking.id}: ${finalizeResult.reason}. Refund: ${refundResult.success ? refundResult.refundId : refundResult.error}`,
              ip: clientIP,
              userId: session.userId,
              homestayId: booking.homestayId
            });
            return jsonResponse({
              success: false,
              paid: false,
              refunded: refundResult.success === true,
              message: refundResult.success
                ? 'Your booking was cancelled. The payment has been refunded to your account.'
                : 'Your booking was cancelled, but the refund could not be processed automatically. Please contact support.',
              paymentStatus: refundResult.success ? 'refunded' : 'cancelled'
            }, 200, request);
          }

          // If WE finalized it and code was newly generated, send email.
          if (finalizeResult.finalized && finalizeResult.codeWasMissing) {
            await sendCheckinEmail(finalizeResult.booking, env);
          }

          const { checkinCode, ...safeBooking } = finalizeResult.booking;
          return jsonResponse({ success: true, booking: safeBooking, paid: true }, 200, request);
        } else if (purchaseStatus === 'cancelled' || purchaseStatus === 'expired' || purchaseStatus === 'failed') {
          // Only downgrade the status if the booking is still awaiting payment.
          // C4: this write must happen under the canonical lock.
          let writeResult;
          try {
            writeResult = await withLock(db, BOOKINGS_LOCK, async (db) => {
              const rr = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
              let bb = [];
              try { if (rr?.data) bb = JSON.parse(rr.data); } catch (_) {}
              const ii = bb.findIndex(b => String(b.id) === String(bookingId));
              if (ii === -1) return { error: 'Booking not found', status: 404 };
              const cur = bb[ii];
              const currentStatus = String(cur.status || '');
              const isTerminal = currentStatus === 'Paid - Awaiting Check-in'
                || currentStatus.startsWith('Completed')
                || /cancelled|refunded|expired/i.test(currentStatus);
              if (isTerminal) {
                return { isTerminal: true, booking: cur };
              }
              bb[ii] = {
                ...cur,
                status: 'Payment Failed',
                chip_status: purchaseStatus,
                statusUpdated: new Date().toISOString()
              };
              await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
                .bind('kd_bookings', JSON.stringify(bb))
                .run();
              return { updated: true, booking: bb[ii] };
            }, 30000);
          } catch (lockErr) {
            if (lockErr.message && lockErr.message.includes('in progress')) {
              return jsonResponse({ error: 'Another operation is in progress. Please retry in a moment.' }, 429, request);
            }
            throw lockErr;
          }

          if (writeResult.error) {
            return jsonResponse({ error: writeResult.error }, writeResult.status || 400, request);
          }

          const finalBooking = writeResult.booking;
          const { checkinCode, ...safeBooking } = finalBooking;
          const wasTerminal = writeResult.isTerminal === true;
          return jsonResponse({
            success: false,
            message: wasTerminal
              ? 'Payment already confirmed.'
              : 'Payment failed or expired.',
            retry: !wasTerminal,
            booking: safeBooking,
            paymentStatus: wasTerminal ? 'paid' : 'failed'
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
