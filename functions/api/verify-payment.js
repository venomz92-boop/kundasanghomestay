// /api/verify-payment.js — Plain English: when the guest comes back from
// the CHIP payment page, this file asks CHIP whether the payment actually
// went through and, if so, marks the booking as paid.
//
// [PHASE 2 REFACTOR]
// All the finalize + auto-refund + email logic that used to live here has
// moved to _utils.js and is now called via finalizeAndNotify(). This file
// no longer owns any local copy of:
//   - tryAutoRefundLatePaymentLocked
//   - sendCheckinEmail
//   - the withLock + finalize + refund + email block
//
// The email-retry bug is fixed: if the webhook already finalized this
// booking but its email send failed, finalizeAndNotify retries it. Before
// this refactor, this file returned "already paid" and never re-sent.
//
// Uses per-booking locks (booking:<id>) instead of the global
// 'bookings-global' lock, so different bookings no longer serialize.
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
  finalizeAndNotify,
  parseJSONSafely
} from './_utils.js';

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

    let body;
    try {
      body = await parseJSONSafely(request);
    } catch (e) {
      return jsonResponse({ error: 'Invalid request body' }, 400, request);
    }
    const bookingId = body?.bookingId;
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    // Unlocked read for ownership + initial state check.
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
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
      // Even if we're returning early, try to fix a stuck email.
      // This handles the case where the webhook finalized but the email
      // send failed, and the guest is now refreshing the return page.
      const notify = await finalizeAndNotify(db, bookingId, env);
      const finalBooking = notify.booking || booking;
      const { checkinCode, ...safeBooking } = finalBooking;
      return jsonResponse({ success: true, booking: safeBooking, paid: true }, 200, request);
    }

    // ===== 4b. Refunded / cancelled / expired are NOT "failed" =====
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

    // ===== 5. CHIP CHECK =====
    if (!booking.chip_purchase_id) {
      // No CHIP purchase exists for this booking yet.
      const { checkinCode, ...safeBooking } = booking;
      return jsonResponse({
        success: false,
        message: 'No payment provider found for this booking.',
        retry: true,
        booking: safeBooking,
        paymentStatus: 'pending'
      }, 200, request);
    }

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

    let purchase = null;
    try {
      const resp = await fetch(
        `https://gate.chip-in.asia/api/v1/purchases/${booking.chip_purchase_id}/`,
        { headers: { 'Authorization': `Bearer ${chipSecret}` } }
      );
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
      purchase = await resp.json();
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

    const purchaseStatus = String(purchase.status || '');

    // ===== 5a. CHIP says paid =====
    if (purchaseStatus === 'completed' || purchaseStatus === 'paid') {
      // finalizeAndNotify handles the lock, the finalize, the auto-refund
      // on cancelled bookings, and the check-in email (with retry).
      const notify = await finalizeAndNotify(db, bookingId, env);

      if (notify.outcome === 'error') {
        const statusCode = notify.retryable ? 500 : 400;
        return jsonResponse({ error: notify.error || 'Finalization failed' }, statusCode, request);
      }

      if (notify.outcome === 'lock_busy') {
        return jsonResponse(
          { error: 'Another operation is in progress. Please retry in a moment.' },
          429,
          request
        );
      }

      if (notify.outcome === 'refused') {
        // Booking was cancelled before payment settled. Auto-refund
        // already ran inside finalizeAndNotify.
        const rr = notify.refundResult || { error: 'refund not attempted' };
        await logAction({
          db,
          action: rr.success ? 'late_payment_auto_refunded' : 'late_payment_refund_failed',
          admin: 'system',
          details: `Refused to finalize ${booking.id}: ${notify.refuseReason || 'cancelled'}. Refund: ${rr.success ? rr.refundId : rr.error}`,
          ip: clientIP,
          userId: session.userId,
          homestayId: booking.homestayId
        });
        return jsonResponse({
          success: false,
          paid: false,
          refunded: rr.success === true,
          message: rr.success
            ? 'Your booking was cancelled. The payment has been refunded to your account.'
            : 'Your booking was cancelled, but the refund could not be processed automatically. Please contact support.',
          paymentStatus: rr.success ? 'refunded' : 'cancelled'
        }, 200, request);
      }

      // finalized or already_finalized — either way, this booking is
      // now paid. Strip the check-in code from the response (it goes by
      // email only).
      const finalBooking = notify.booking || booking;
      const { checkinCode, ...safeBooking } = finalBooking;
      return jsonResponse({ success: true, booking: safeBooking, paid: true }, 200, request);
    }

    // ===== 5b. CHIP says cancelled / expired / failed =====
    if (purchaseStatus === 'cancelled' || purchaseStatus === 'expired' || purchaseStatus === 'failed') {
      let writeResult;
      try {
        writeResult = await withLock(db, 'bookings-global', async (db) => {
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
          return jsonResponse(
            { error: 'Another operation is in progress. Please retry in a moment.' },
            429,
            request
          );
        }
        throw lockErr;
      }

      if (writeResult.error) {
        return jsonResponse({ error: writeResult.error }, writeResult.status || 400, request);
      }

      const { checkinCode, ...safeBooking } = writeResult.booking;
      const wasTerminal = writeResult.isTerminal === true;
      return jsonResponse({
        success: false,
        message: wasTerminal ? 'Payment already confirmed.' : 'Payment failed or expired.',
        retry: !wasTerminal,
        booking: safeBooking,
        paymentStatus: wasTerminal ? 'paid' : 'failed'
      }, 200, request);
    }

    // ===== 5c. Any other status = still pending =====
    const { checkinCode, ...safeBooking } = booking;
    return jsonResponse({
      success: false,
      message: 'Payment not yet confirmed.',
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
