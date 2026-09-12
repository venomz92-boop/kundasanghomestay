// /api/chip-create.js — Plain English: this file creates a CHIP payment
// session for a guest's pending booking. Every write to the bookings list
// now happens inside the one shared global lock, so it can never race with
// a booking creation, check-in, cancellation, admin edit, or the CHIP
// webhook. The "resume an existing payment" path also re-checks the
// booking state inside the lock before saving, so a payment that finalized
// a millisecond earlier cannot be silently reset back to "Pending".
//
// [THIS REVISION]
// Refund calculation uses `amount_paid` (the amount CHIP actually
// collected) instead of `total` (which can be recalculated by an admin
// editing dates on a paid booking).
import {
  corsHeaders,
  enforceHttps,
  getClientIP,
  getGuestSession,
  logAction,
  getCSRFToken,
  validateCSRFToken,
  jsonResponse,
  checkRateLimit,
  recordRateLimit,
  withLock,
  finalizePaidBooking
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';

// ============================================================
// Auto-refund helper.
// IMPORTANT: the CALLER must already hold the bookings lock.
// We do NOT take our own withLock here so that chip-create,
// verify-payment, and chip-webhook all serialize on the SAME
// key (C4). The CHIP refund HTTP call happens inside the caller's
// lock; the staleTimeoutMs on that lock is long enough for a
// typical CHIP round-trip.
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

  // [FIX 1.4] Refund the amount CHIP actually collected.
  const refundAmountCents = Math.round(Number(b.amount_paid || b.total) * 100);

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
    bookings[idx].refund_amount = Number(b.amount_paid || b.total) || 0;
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

// ============================================================
// Email helper – used when we discover an already-paid purchase
// but the webhook/verify-payment never ran.
// ============================================================
async function sendCheckinCodeEmail(to, guestName, bookingId, checkinCode, homestayName, checkin, checkout, env) {
  const html = `
    <h2>Hello ${guestName || 'Guest'},</h2>
    <p>Your booking <strong>${bookingId}</strong> at <strong>${homestayName}</strong> has been paid successfully.</p>
    <p><strong>Check-in:</strong> ${checkin}</p>
    <p><strong>Check-out:</strong> ${checkout}</p>
    <p style="font-size:24px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
      🏔️ Your 6-digit check-in code: <span style="color:#0F382E;">${checkinCode}</span>
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
          subject: 'Your Check-in Code – Payment Confirmed',
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
          subject: 'Your Check-in Code – Payment Confirmed',
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

    const csrf = getCSRFToken(request);
    if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) {
      return jsonResponse({ error: 'Invalid security token' }, 403, request);
    }

    const { bookingId } = await request.json();
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // Rate limiting per guest and booking
    const clientIP = getClientIP(request);
    const rateKey = `chip_create_${bookingId}`;
    const rateOk = await checkRateLimit(db, clientIP, rateKey, 3, 5 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many payment attempts. Please wait 5 minutes.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, rateKey);

    // Unlocked read for ownership + initial state check
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b =>
      String(b.id) === String(bookingId) && String(b.guestId) === String(session.userId)
    );
    if (idx === -1) return jsonResponse({ error: 'Booking not found' }, 404, request);

    const booking = bookings[idx];

    // Already paid — short circuit
    const s = String(booking.status || '');
    if (s === 'Paid - Awaiting Check-in' || s === 'Completed' || s.startsWith('Completed')) {
      return jsonResponse({
        success: true,
        alreadyPaid: true,
        message: 'This booking is already paid.',
        bookingId: booking.id
      }, 200, request);
    }

    const chipSecret = env.CHIP_SECRET_KEY;
    if (!chipSecret) {
      return jsonResponse({ error: 'Payment service unavailable. Please try again later.' }, 500, request);
    }

    const existingPurchaseId = booking.chip_purchase_id;
    const existingCheckoutUrl = booking.chip_checkout_url;

    // ============================================================
    // If we have an existing purchase, query its status first.
    // ============================================================
    if (existingPurchaseId) {
      try {
        const resp = await fetch(`https://gate.chip-in.asia/api/v1/purchases/${existingPurchaseId}/`, {
          headers: { 'Authorization': `Bearer ${chipSecret}` }
        });
        if (resp.ok) {
          const purchase = await resp.json();
          const status = purchase.status;

          // ---- Purchase is already paid ----
          if (status === 'paid' || status === 'completed') {
            let lockResult;
            try {
              // C4: canonical lock. Finalize + potential auto-refund both
              // happen inside this one lock block.
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
                // Some other path is finalizing this booking. Give it a
                // moment, then re-read and answer based on the fresh state.
                await new Promise(res => setTimeout(res, 800));
                const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
                let bb = [];
                try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
                const cur = bb.find(b => String(b.id) === String(booking.id));
                if (cur && (cur.status === 'Paid - Awaiting Check-in' || String(cur.status).startsWith('Completed'))) {
                  return jsonResponse({
                    success: true,
                    alreadyPaid: true,
                    message: 'Payment already completed.',
                    bookingId: booking.id
                  }, 200, request);
                }
              }
              throw lockErr;
            }

            const finalizeResult = lockResult.finalizeResult;

            if (finalizeResult.error) {
              return jsonResponse({ error: finalizeResult.error }, 500, request);
            }

            // Refused to finalize → booking was cancelled before payment
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
                alreadyPaid: false,
                refunded: refundResult.success === true,
                message: refundResult.success
                  ? 'Your booking was cancelled. The payment has been refunded to your account.'
                  : 'Your booking was cancelled, but the refund could not be processed automatically. Please contact support.'
              }, 200, request);
            }

            // Fresh finalization with a newly generated code → send email.
            if (finalizeResult.finalized && finalizeResult.codeWasMissing) {
              try {
                await sendCheckinCodeEmail(
                  finalizeResult.booking.guestEmail,
                  finalizeResult.booking.guestName || 'Guest',
                  finalizeResult.booking.id,
                  finalizeResult.checkinCode,
                  finalizeResult.booking.homestay || 'Kundasang Homestay',
                  finalizeResult.booking.checkin,
                  finalizeResult.booking.checkout,
                  env
                );
              } catch (mailErr) {
                console.error('Check-in email failed:', mailErr.message);
              }
            }

            await logAction({
              db,
              action: 'chip_payment_already_paid',
              admin: 'guest',
              details: `Booking ${booking.id} found paid in CHIP via chip-create; ${finalizeResult.finalized ? 'finalized' : 'already finalized'}`,
              ip: clientIP,
              userId: session.userId,
              homestayId: booking.homestayId
            });

            return jsonResponse({
              success: true,
              alreadyPaid: true,
              message: 'Payment already completed.',
              bookingId: booking.id
            }, 200, request);
          }

          // ---- Purchase still pending: return existing checkout URL ----
          if (['created', 'sent', 'viewed'].includes(status)) {
            if (existingCheckoutUrl) {
              return jsonResponse({
                success: true,
                url: existingCheckoutUrl,
                alreadyPaid: false,
                message: 'Resuming existing payment session.'
              }, 200, request);
            } else if (purchase.checkout_url) {
              // We have a live session at CHIP but no cached URL. Cache it
              // inside the lock, but ONLY if the booking hasn't moved on.
              try {
                await withLock(db, BOOKINGS_LOCK, async (db) => {
                  const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
                  let bb = [];
                  try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
                  const ii = bb.findIndex(b => String(b.id) === String(booking.id));
                  if (ii === -1) return;
                  const cur = bb[ii];
                  const curStatus = String(cur.status || '');
                  if (curStatus === 'Paid - Awaiting Check-in'
                      || curStatus.startsWith('Completed')
                      || /cancelled|refunded|expired/i.test(curStatus)) {
                    return; // Don't touch terminal bookings.
                  }
                  bb[ii] = { ...cur, chip_checkout_url: purchase.checkout_url };
                  await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
                    .bind('kd_bookings', JSON.stringify(bb))
                    .run();
                }, 30000);
              } catch (lockErr) {
                // Not fatal: we can still return the URL to the guest.
                console.warn('chip-create: could not cache checkout_url:', lockErr.message);
              }
              return jsonResponse({
                success: true,
                url: purchase.checkout_url,
                alreadyPaid: false,
                message: 'Resuming existing payment session.'
              }, 200, request);
            }
          }
          // Fall through to create a new purchase for cancelled/expired/failed
        }
      } catch (e) {
        // Network error talking to CHIP — fall through and try creating a new session.
        console.warn('chip-create: CHIP lookup failed:', e.message);
      }
    }

    // ============================================================
    // Create a NEW CHIP purchase
    // ============================================================
    const CHIP_API = 'https://gate.chip-in.asia/api/v1/purchases/';
    const amountCents = Math.round(Number(booking.total) * 100);
    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';

    const payload = {
      client: {
        email: booking.guestEmail || session.email,
        full_name: booking.guestName || 'Guest'
      },
      purchase: {
        products: [
          {
            name: `${booking.homestay} (${booking.checkin} to ${booking.checkout})`,
            price: amountCents,
            quantity: 1
          }
        ]
      },
      brand_id: env.CHIP_BRAND_ID,
      skip_thank_you: true,
      platform: 'web',
      success_redirect: `${domain}/?booking=${encodeURIComponent(booking.id)}&payment_return=1`,
      failure_redirect: `${domain}/?booking=${encodeURIComponent(booking.id)}&payment=cancel`,
      cancel_redirect: `${domain}/?booking=${encodeURIComponent(booking.id)}&payment=cancel`,
      success_callback: `${domain}/api/chip-webhook`
    };

    const response = await fetch(CHIP_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${chipSecret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok || !data.id) {
      return jsonResponse({ error: 'Payment gateway error. Please try again.' }, 502, request);
    }

    // ============================================================
    // Save the new CHIP session under the canonical lock. Re-check
    // status INSIDE the lock — the webhook or verify-payment may have
    // finalized or cancelled this booking while we were on the wire.
    // ============================================================
    let writeResult;
    try {
      writeResult = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let bb = [];
        try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
        const ii = bb.findIndex(b => String(b.id) === String(booking.id));
        if (ii === -1) return { error: 'Booking not found', status: 404 };

        const cur = bb[ii];
        const curStatus = String(cur.status || '');

        if (curStatus === 'Paid - Awaiting Check-in' || curStatus.startsWith('Completed')) {
          return { alreadyFinalized: true, booking: cur };
        }
        if (/cancelled|refunded|expired/i.test(curStatus)) {
          return { terminal: true, booking: cur };
        }

        const isRetry = curStatus === 'Payment Failed';
        const nowIso = new Date().toISOString();

        bb[ii] = {
          ...cur,
          status: isRetry ? 'Pending Payment' : cur.status,
          date: isRetry ? nowIso : cur.date,
          statusUpdated: nowIso,
          chip_purchase_id: data.id,
          chip_checkout_url: data.checkout_url,
          chip_status: data.status || 'pending',
          paymentProvider: 'CHIP'
        };

        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_bookings', JSON.stringify(bb))
          .run();

        return { success: true, isRetry };
      }, 30000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        // We couldn't acquire the lock in time, but the CHIP purchase
        // already exists. The webhook (matched by purchase id) will
        // finalize the booking when payment succeeds. Return the URL
        // anyway so the guest isn't stuck staring at a spinner.
        return jsonResponse({
          success: true,
          url: data.checkout_url,
          purchase_id: data.id,
          bookingId: booking.id,
          amount: Number(booking.total),
          warning: 'Booking record will be reconciled automatically after payment.'
        }, 200, request);
      }
      throw lockErr;
    }

    if (writeResult.error) {
      return jsonResponse({ error: writeResult.error }, writeResult.status || 400, request);
    }

    if (writeResult.alreadyFinalized || writeResult.terminal) {
      return jsonResponse({
        success: false,
        alreadyPaid: writeResult.alreadyFinalized === true,
        message: writeResult.alreadyFinalized
          ? 'This booking is already paid.'
          : 'This booking is no longer payable.',
        bookingId: booking.id
      }, 200, request);
    }

    await logAction({
      db,
      action: 'chip_purchase_created',
      admin: 'guest',
      details: `New purchase ${data.id} created for ${booking.id}${writeResult.isRetry ? ' (retry after failed payment)' : ''}`,
      ip: clientIP,
      userId: session.userId,
      homestayId: booking.homestayId
    });

    return jsonResponse({
      success: true,
      url: data.checkout_url,
      purchase_id: data.id,
      bookingId: booking.id,
      amount: Number(booking.total)
    }, 200, request);

  } catch (error) {
    console.error('CHIP create error:', error.message);
    return jsonResponse({ error: 'Payment setup failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
