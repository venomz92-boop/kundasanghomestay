// /api/owner-checkin.js — Host confirms guest check-in and triggers CHIP Send payout.
//
// [THIS REVISION]
// The ownership check now resolves the owner's homestay IDs FRESH from D1
// via getOwnerHomestayIdsFresh() in _utils.js. Previously it trusted the
// session token's `homestayIds` snapshot, which went stale whenever a
// listing was approved after the token was minted. Symptom:
//   "Unauthorized – you do not own this homestay"
// on check-in for a listing approved after the session token was issued.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  getOwnerSession,
  jsonResponse,
  recordCheckinAttempt,
  getRecentCheckinAttempts,
  clearCheckinAttempts,
  withLock,
  chipSendPayout,
  getOwnerHomestayIdsFresh
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';

const GATEWAY_FEE = 1.00;

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const ownerData = await getOwnerSession(request, env);
    if (!ownerData || ownerData.type !== 'owner') {
      return jsonResponse({ error: 'Unauthorized' }, 401, request);
    }

    const body = await request.json();
    const bookingId = body.bookingId;
    const checkinCode = body.checkinCode;

    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    if (!checkinCode || !/^\d{6}$/.test(checkinCode)) {
      return jsonResponse({ error: 'Check-in code must be exactly 6 digits' }, 400, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Database unavailable' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // Pre-fetch for auth check (read-only, no lock needed)
    const storeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let preBookings = [];
    try { if (storeRes?.data) preBookings = JSON.parse(storeRes.data); } catch (_) {}
    const preBooking = preBookings.find(b => String(b.id) === String(bookingId));
    if (!preBooking) return jsonResponse({ error: 'Invalid request.' }, 400, request);

    // Resolve owner's homestay IDs FRESH from D1, not from the session
    // token's snapshot.
    const allowedIds = await getOwnerHomestayIdsFresh(db, ownerData);
    if (!allowedIds.map(String).includes(String(preBooking.homestayId))) {
      return jsonResponse({ error: 'Unauthorized – you do not own this homestay' }, 403, request);
    }

    if (preBooking.payoutUnknown) {
      return jsonResponse({
        error: `Payout for this booking is in UNKNOWN state (last attempt: ${preBooking.payoutUnknownAt || 'unknown time'}). Please log into your CHIP dashboard and verify whether a payout with reference KDH-${bookingId} exists before contacting support.`
      }, 409, request);
    }

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const freshRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
        let bookings = [];
        try { if (freshRes?.data) bookings = JSON.parse(freshRes.data); } catch (_) {}
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx === -1) return { error: 'Booking not found', status: 404 };
        const booking = bookings[idx];

        if (booking.payoutSuccessDate || booking.ownerPayoutId) {
          return {
            alreadyPaid: true,
            message: `Booking already completed and paid out on ${booking.payoutSuccessDate || booking.checkedInAt || 'unknown date'}.`,
            bookingId,
            payoutAmount: booking.payoutAmount || null,
            ownerPayoutId: booking.ownerPayoutId || null
          };
        }

        if (booking.payoutUnknown) {
          return {
            error: `Payout is in UNKNOWN state. Check CHIP dashboard for reference KDH-${bookingId}.`,
            status: 409
          };
        }

        // UNRESOLVED-ATTEMPT GUARD.
        if (booking.payoutAttemptedAt
            && !booking.payoutSuccessDate
            && !booking.payoutUnknown
            && !booking.payoutFailedAttempt
            && !booking.ownerPayoutId) {
          return {
            error: `A previous payout attempt at ${booking.payoutAttemptedAt} has an unresolved outcome. Log into your CHIP dashboard and check for reference ${booking.payoutAttemptedReference || 'KDH-' + bookingId}. If no payout exists, contact support to clear the marker before retrying.`,
            status: 409
          };
        }

        if (!booking.status || !booking.status.toLowerCase().includes('paid')) {
          return { error: 'Booking is not paid yet', status: 400 };
        }

        const maxAttempts = 5;
        const windowMs = 60 * 60 * 1000;
        const attempts = await getRecentCheckinAttempts(db, bookingId, windowMs);
        if (attempts >= maxAttempts) {
          return {
            error: 'Too many failed check-in attempts. Please wait 1 hour before retrying.',
            status: 429,
            retryAfter: 3600
          };
        }

        if (!booking.checkinCode) {
          return {
            error: 'This booking does not have a check-in code. Please ask the guest to use the "Resend Code" button in their My Bookings page.',
            status: 400
          };
        }
        if (booking.checkinCode !== checkinCode) {
          await recordCheckinAttempt(db, bookingId);
          return {
            error: 'Invalid check-in code. Please ask the guest for the 6-digit code sent to their email.',
            status: 400
          };
        }
        await clearCheckinAttempts(db, bookingId);

        // Find homestay
        let homestay = null;
        let homestaySource = null;
        for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind(store).first();
          let list = [];
          try { if (r?.data) list = JSON.parse(r.data); } catch (_) {}
          const found = list.find(h => String(h.id) === String(booking.homestayId));
          if (found) { homestay = found; homestaySource = store; break; }
        }

        if (!homestay) {
          return { error: 'Homestay not found for this booking', status: 404 };
        }

        const ownerAmount = Number(booking.base) || 0;
        if (ownerAmount <= 0) {
          return { error: 'Invalid booking base amount', status: 400 };
        }

        const isLive = !!(env.CHIP_API_KEY && env.CHIP_API_SECRET);
        const isProduction = env.ENVIRONMENT === 'production';
        const simulationAllowed = !isProduction && env.ALLOW_PAYOUT_SIMULATION === 'true';

        // C1: HARD GATE. Simulation only in non-prod with explicit flag.
        if (!isLive && isProduction) {
          bookings[idx].status = 'Completed - Payout Pending';
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].payoutFailedAttempt = true;
          bookings[idx].lastPayoutError = 'Payout configuration missing in production: CHIP_API_KEY / CHIP_API_SECRET not set. Contact admin.';
          bookings[idx].homestaySource = homestaySource;
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
          await logAction({
            db,
            action: 'owner_checkin_payout_config_error',
            admin: 'owner',
            details: `Check-in ${bookingId} blocked: CHIP keys missing in production`,
            ip: getClientIP(request),
            userId: booking.guestEmail,
            homestayId: booking.homestayId
          });
          return {
            error: 'Payout configuration missing on server. Your booking was NOT marked as paid. Please contact support — admin must check CHIP_API_KEY / CHIP_API_SECRET env vars.',
            status: 500
          };
        }

        if (!isLive && simulationAllowed) {
          // Simulate success (non-production only).
          bookings[idx].status = 'Completed - Payout Success';
          bookings[idx].payoutSuccess = true;
          bookings[idx].payoutSuccessDate = new Date().toISOString();
          bookings[idx].payoutAmount = ownerAmount;
          bookings[idx].payoutMethod = 'Simulated';
          bookings[idx].ownerPayoutId = 'SIM_' + Date.now();
          bookings[idx].completedDate = new Date().toISOString();
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].homestaySource = homestaySource;
          bookings[idx].payoutFailedAttempt = false;
          delete bookings[idx].lastPayoutError;

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          await logAction({
            db,
            action: 'owner_checkin_simulation',
            admin: 'owner',
            details: `Check-in ${bookingId}, payout SIMULATED (non-prod)`,
            ip: getClientIP(request),
            userId: booking.guestEmail,
            homestayId: booking.homestayId
          });

          return {
            success: true,
            message: `Check-in confirmed! SIMULATED payout of RM${ownerAmount} recorded.`,
            bookingId,
            payoutSuccess: true,
            simulation: true
          };
        }

        if (!isLive && !simulationAllowed) {
          bookings[idx].status = 'Completed - Payout Pending';
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].payoutFailedAttempt = true;
          bookings[idx].lastPayoutError = 'CHIP Send keys missing and ALLOW_PAYOUT_SIMULATION is not "true".';
          bookings[idx].homestaySource = homestaySource;
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
          return {
            error: 'Payout gateway not configured and simulation not allowed. Contact admin.',
            status: 500
          };
        }

        // ---------- LIVE CHIP Send payout ----------
        const reference = `KDH-${bookingId}`;

        // PRE-FLIGHT WRITE. Persist the attempt marker BEFORE calling CHIP Send.
        bookings[idx].payoutAttemptedAt = new Date().toISOString();
        bookings[idx].payoutAttemptedReference = reference;
        bookings[idx].payoutAttemptedAmount = ownerAmount;
        try {
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
        } catch (preflightErr) {
          return {
            error: `Could not record the payout attempt before contacting CHIP (${preflightErr.message}). No payout was sent. Please try again.`,
            status: 500
          };
        }

        const payoutResult = await chipSendPayout({
          db,
          homestayId: booking.homestayId,
          homestay,
          amount: ownerAmount,
          reference,
          description: `Owner payout for ${bookingId}`,
          env
        });

        let payoutSuccess = false;
        let payoutUnknown = false;
        const isSimulation = false;

        if (payoutResult.success) {
          payoutSuccess = true;
          bookings[idx].status = 'Completed - Payout Success';
          bookings[idx].payoutSuccess = true;
          bookings[idx].payoutSuccessDate = new Date().toISOString();
          bookings[idx].payoutAmount = Number(ownerAmount);
          bookings[idx].payoutMethod = 'CHIP Send';
          bookings[idx].ownerPayoutId = payoutResult.payoutId;
          bookings[idx].completedDate = new Date().toISOString();
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].homestaySource = homestaySource;
          bookings[idx].payoutFailedAttempt = false;
          delete bookings[idx].lastPayoutError;
        } else if (payoutResult.unknown) {
          payoutUnknown = true;
          bookings[idx].status = 'Completed - Payout Unknown';
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].payoutUnknown = true;
          bookings[idx].payoutUnknownAt = new Date().toISOString();
          bookings[idx].payoutUnknownError = payoutResult.error;
          bookings[idx].homestaySource = homestaySource;
        } else {
          bookings[idx].status = 'Completed - Payout Pending';
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].payoutFailedAttempt = true;
          bookings[idx].lastPayoutError = payoutResult.error;
          bookings[idx].homestaySource = homestaySource;
        }

        // ATOMIC WRITE: booking + platform-fee in ONE batch.
        let feeEarningsToWrite = null;
        if (payoutSuccess && !isSimulation) {
          try {
            const feeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
            let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
            feeEarnings.history = feeEarnings.history || [];
            const alreadyRecorded = feeEarnings.history.some(h => h.bookingId === bookingId && h.type === 'earning');
            if (!alreadyRecorded) {
              const feeToRecord = (Number(booking.fee) || 0) + (Number(booking.gatewayFee) || GATEWAY_FEE);
              if (feeToRecord > 0) {
                feeEarnings.total = (feeEarnings.total || 0) + feeToRecord;
                feeEarnings.available = (feeEarnings.available || 0) + feeToRecord;
                feeEarnings.history.push({
                  bookingId,
                  fee: feeToRecord,
                  date: new Date().toISOString(),
                  type: 'earning',
                  payoutToOwner: Number(ownerAmount),
                  method: 'chip_send',
                  ip: getClientIP(request)
                });
                feeEarningsToWrite = feeEarnings;
              }
            }
          } catch (feeReadErr) {
            console.error('Could not read fee earnings before atomic batch:', feeReadErr.message);
            return {
              error: `Payout succeeded at CHIP but the platform fee could not be prepared for write (${feeReadErr.message}). Booking left in "attempt marker only" state. Verify reference ${reference} in the CHIP dashboard, then contact support to reconcile.`,
              status: 500
            };
          }
        }

        const atomicStmts = [
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
        ];
        if (feeEarningsToWrite) {
          atomicStmts.push(
            db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_fee_earnings', JSON.stringify(feeEarningsToWrite))
          );
        }

        try {
          await db.batch(atomicStmts);
        } catch (batchErr) {
          console.error('Atomic batch write failed:', batchErr.message);
          return {
            error: `Could not persist the payout result (${batchErr.message}). Booking left in "attempt marker only" state. Verify reference ${reference} in the CHIP dashboard before retrying.`,
            status: 500
          };
        }

        await logAction({
          db,
          action: payoutSuccess
            ? (isSimulation ? 'owner_checkin_simulation' : 'owner_checkin_payout_success')
            : (payoutUnknown ? 'owner_checkin_payout_unknown' : 'owner_checkin_payout_failed'),
          admin: 'owner',
          details: `Check-in ${bookingId}, payout ${payoutSuccess ? (isSimulation ? 'simulated' : 'success') : (payoutUnknown ? 'UNKNOWN' : 'failed')}${payoutResult.payoutId ? ' id=' + payoutResult.payoutId : ''}`,
          ip: getClientIP(request),
          userId: booking.guestEmail,
          homestayId: booking.homestayId
        });

        return {
          success: payoutSuccess,
          message: payoutSuccess
            ? `Check-in confirmed! Payout of RM${ownerAmount} sent to owner via CHIP Send.`
            : (payoutUnknown
                ? `Check-in confirmed, but payout status is UNKNOWN. Reference ${reference} may have been sent — check your CHIP dashboard before retrying.`
                : `Check-in confirmed, but payout failed: ${payoutResult.error}`),
          bookingId,
          payoutSuccess,
          payoutUnknown,
          simulation: isSimulation,
          homestaySource,
          warning: payoutUnknown ? 'Payout state unknown. Check CHIP dashboard before retrying.' : undefined
        };
      }, 60000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        return jsonResponse({ error: 'Check-in is already in progress for this booking. Please wait a moment.' }, 429, request);
      }
      throw lockErr;
    }

    if (result.error) {
      return jsonResponse({ error: result.error, retryAfter: result.retryAfter }, result.status || 400, request);
    }
    return jsonResponse(result, 200, request);

  } catch (e) {
    console.error('Check-in error:', e.message);
    return jsonResponse({ error: 'Check-in failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
