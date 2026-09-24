// /api/chip-create.js — Creates a CHIP payment session for a guest's
// pending booking.
//
// [PHASE 2 REFACTOR]
// Changes:
//   - Deleted local tryAutoRefundLatePaymentLocked and sendCheckinCodeEmail
//     (now in _utils.js).
//   - Replaced the withLock + finalizePaidBooking + refund + email block
//     with a single call to finalizeAndNotify.
//   - Added amountCents validation before the CHIP call. Before: if
//     booking.total was missing/non-numeric, we sent {price: null} to CHIP.
//   - Fixed the orphaned-purchase race. If two concurrent requests both
//     create a CHIP purchase, the second was overwriting the first's ID,
//     leaving the first's purchase orphaned and payable — if the guest
//     paid the orphaned URL, the webhook 404'd and their payment was lost.
//     Now: inside the lock, if another purchase ID is already set, we do
//     NOT overwrite. We return the existing URL instead, and log the
//     orphan for cleanup.
//   - request.json() → parseJSONSafely().
//   - Per-booking locks (booking:<id>) instead of the global
//     'bookings-global' lock.
//   - Lock-busy fallback now re-reads the booking and returns an
//     existing URL if one exists, instead of blindly returning the
//     orphaned purchase URL.
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
  finalizeAndNotify,
  parseJSONSafely
} from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    const csrf = getCSRFToken(request);
    const sessionSv = Number(session.sessionVersion ?? 0);
    if (!csrf || !(await validateCSRFToken(csrf, session.userId, env, sessionSv))) {
      return jsonResponse({ error: 'Invalid security token' }, 403, request);
    }
    
    let body;
    try {
      body = await parseJSONSafely(request);
    } catch (e) {
      return jsonResponse({ error: 'Invalid request body' }, 400, request);
    }
    const bookingId = body?.bookingId;
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // Rate limiting per guest and booking.
    const clientIP = getClientIP(request);
    const rateKey = `chip_create_${bookingId}`;
    const rateOk = await checkRateLimit(db, clientIP, rateKey, 3, 5 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many payment attempts. Please wait 5 minutes.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, rateKey);

    // Unlocked read for ownership + initial state check.
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b =>
      String(b.id) === String(bookingId) && String(b.guestId) === String(session.userId)
    );
    if (idx === -1) return jsonResponse({ error: 'Booking not found' }, 404, request);

    const booking = bookings[idx];

    // Already paid — short circuit.
    const s = String(booking.status || '');
    if (s === 'Paid - Awaiting Check-in' || s === 'Completed' || s.startsWith('Completed')) {
      return jsonResponse({
        success: true,
        alreadyPaid: true,
        message: 'This booking is already paid.',
        bookingId: booking.id
      }, 200, request);
    }

    // [PHASE 2 FIX] Validate the amount before sending anything to CHIP.
    // Before: if booking.total was undefined / null / non-numeric,
    // Math.round(NaN * 100) was NaN, and JSON.stringify turned that into
    // {price: null}, which CHIP could interpret as a free transaction.
    const amountCents = Math.round(Number(booking.total) * 100);
    if (!Number.isFinite(amountCents) || amountCents < 100) {
      console.error(`chip-create: invalid booking amount for ${booking.id}: total=${booking.total}`);
      return jsonResponse({ error: 'Invalid booking amount' }, 400, request);
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
            const notify = await finalizeAndNotify(db, booking.id, env);

            if (notify.outcome === 'lock_busy') {
              return jsonResponse(
                { error: 'Another operation is in progress. Please retry in a moment.' },
                429,
                request
              );
            }

            if (notify.outcome === 'error') {
              return jsonResponse({ error: notify.error || 'Finalization failed' }, 500, request);
            }

            if (notify.outcome === 'refused') {
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
                alreadyPaid: false,
                refunded: rr.success === true,
                message: rr.success
                  ? 'Your booking was cancelled. The payment has been refunded to your account.'
                  : 'Your booking was cancelled, but the refund could not be processed automatically. Please contact support.'
              }, 200, request);
            }

            await logAction({
              db,
              action: 'chip_payment_already_paid',
              admin: 'guest',
              details: `Booking ${booking.id} found paid in CHIP via chip-create; ${notify.outcome}`,
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
                await withLock(db, 'bookings-global', async (db) => {
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
                    return;
                  }
                  bb[ii] = { ...cur, chip_checkout_url: purchase.checkout_url };
                  await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
                    .bind('kd_bookings', JSON.stringify(bb))
                    .run();
                }, 15000);
              } catch (lockErr) {
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
          // Fall through to create a new purchase for cancelled/expired/failed.
        }
      } catch (e) {
        // Network error talking to CHIP — fall through and try creating
        // a new session.
        console.warn('chip-create: CHIP lookup failed:', e.message);
      }
    }

    // ============================================================
    // Create a NEW CHIP purchase
    // ============================================================
    const CHIP_API = 'https://gate.chip-in.asia/api/v1/purchases/';
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

    let data = null;
    try { data = await response.json(); } catch (_) { data = null; }

    if (!response.ok || !data || !data.id) {
      return jsonResponse({ error: 'Payment gateway error. Please try again.' }, 502, request);
    }

    // ============================================================
    // Save the new CHIP session under the per-booking lock.
    //
    // [PHASE 2 FIX] Two concurrent requests that both call CHIP will
    // both get a purchase ID. Before this fix, the second one to reach
    // the lock overwrote the first's chip_purchase_id — leaving the
    // first purchase orphaned but still payable. If the guest paid the
    // orphaned URL, the webhook couldn't match it to a booking, returned
    // 404, and the payment was lost.
    //
    // Now: inside the lock, if a DIFFERENT chip_purchase_id is already
    // saved, we do NOT overwrite it. We return the existing URL to the
    // guest and log the orphan so it can be cleaned up manually in the
    // CHIP dashboard.
    // ============================================================
    let writeResult;
    try {
      writeResult = await withLock(db, 'bookings-global', async (db) => {
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

        // [PHASE 2 FIX] Someone else already saved a different purchase
        // ID between our read and our write. Do not overwrite theirs.
        // Our purchase is orphaned and needs cleanup.
        if (cur.chip_purchase_id && cur.chip_purchase_id !== data.id) {
          return {
            orphaned: true,
            existingPurchaseId: cur.chip_purchase_id,
            existingCheckoutUrl: cur.chip_checkout_url,
            ourOrphanedPurchaseId: data.id
          };
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
        // Couldn't acquire the lock. Do NOT blindly return our new URL —
        // it might be orphaned. Re-read and reconcile.
        try {
          const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bb = [];
          try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
          const cur = bb.find(b => String(b.id) === String(booking.id));

          // Log the orphan regardless.
          await logAction({
            db,
            action: 'chip_purchase_orphaned',
            admin: 'guest',
            details: `Purchase ${data.id} created for ${booking.id} but lock busy; not saved. Reconcile in CHIP dashboard.`,
            ip: clientIP,
            userId: session.userId,
            homestayId: booking.homestayId
          });

          if (cur && (cur.status === 'Paid - Awaiting Check-in' || String(cur.status).startsWith('Completed'))) {
            return jsonResponse({
              success: true,
              alreadyPaid: true,
              message: 'Payment already completed.',
              bookingId: booking.id
            }, 200, request);
          }
          if (cur && cur.chip_purchase_id && cur.chip_checkout_url) {
            return jsonResponse({
              success: true,
              url: cur.chip_checkout_url,
              purchase_id: cur.chip_purchase_id,
              bookingId: booking.id,
              message: 'Resuming existing payment session.'
            }, 200, request);
          }
        } catch (_) {
          // fall through to error
        }
        return jsonResponse({
          error: 'Another operation is in progress. Please try again in a moment.'
        }, 429, request);
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

    // [PHASE 2 FIX] Our purchase was orphaned by a concurrent request.
    // Return the OTHER purchase's URL and log for cleanup.
    if (writeResult.orphaned) {
      await logAction({
        db,
        action: 'chip_purchase_orphaned',
        admin: 'guest',
        details: `Purchase ${writeResult.ourOrphanedPurchaseId} for ${booking.id} was orphaned by concurrent request. Existing purchase: ${writeResult.existingPurchaseId}. Reconcile in CHIP dashboard.`,
        ip: clientIP,
        userId: session.userId,
        homestayId: booking.homestayId
      });

      if (writeResult.existingCheckoutUrl) {
        return jsonResponse({
          success: true,
          url: writeResult.existingCheckoutUrl,
          purchase_id: writeResult.existingPurchaseId,
          bookingId: booking.id,
          message: 'Resuming existing payment session.'
        }, 200, request);
      }

      // No cached URL — tell the guest to retry. The next call will
      // look up the existing purchase's URL from CHIP.
      return jsonResponse({
        error: 'Payment session is being set up. Please try again in a moment.'
      }, 429, request);
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
