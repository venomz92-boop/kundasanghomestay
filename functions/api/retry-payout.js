// /api/retry-payout.js — Admin-triggered retry of a failed CHIP Send payout.
// Uses the shared chipSendPayout() helper and the global bookings lock.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  verifyAdminAuth,
  jsonResponse,
  parseJSONSafely,
  withLock,
  chipSendPayout
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';

const GATEWAY_FEE = 1.00;

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const isAdmin = await verifyAdminAuth(request, env);
    if (!isAdmin) {
      return jsonResponse({ error: 'Unauthorized' }, 401, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB unavailable' }, 500, request);

    const body = await parseJSONSafely(request);
    const bookingId = body.bookingId;
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const clientIP = getClientIP(request);

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let bookings = [];
        try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx === -1) return { error: 'Booking not found', status: 404 };

        const booking = bookings[idx];
        if (booking.payoutSuccessDate || booking.ownerPayoutId) {
          return { success: true, alreadyPaid: true, message: 'Already paid out.' };
        }
        if (!booking.checkedInAt) {
          return { error: 'Cannot retry payout before check-in.', status: 400 };
        }
        if (booking.payoutUnknown) {
          return {
            error: `Payout state is UNKNOWN (${booking.payoutUnknownAt || 'unknown time'}). Check CHIP dashboard for reference KDH-${bookingId} before retrying.`,
            status: 409
          };
        }

        if (booking.payoutAttemptedAt
            && !booking.payoutSuccessDate
            && !booking.payoutUnknown
            && !booking.payoutFailedAttempt
            && !booking.ownerPayoutId) {
          return {
            error: `A previous payout attempt at ${booking.payoutAttemptedAt} has an unresolved outcome. Log into the CHIP dashboard and check for reference ${booking.payoutAttemptedReference || 'KDH-' + bookingId}. If no payout exists, contact support to clear the marker before retrying.`,
            status: 409
          };
        }

        // Find homestay
        let homestay = null;
        for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
          const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind(store).first();
          let list = [];
          try { if (rr?.data) list = JSON.parse(rr.data); } catch (_) {}
          const found = list.find(h => String(h.id) === String(booking.homestayId));
          if (found) { homestay = found; break; }
        }
        if (!homestay) return { error: 'Homestay not found', status: 404 };

        const ownerAmount = Number(booking.base) || 0;
        if (ownerAmount <= 0) return { error: 'Invalid booking base amount', status: 400 };

        const isLive = !!(env.CHIP_API_KEY && env.CHIP_API_SECRET);
        const isProduction = env.ENVIRONMENT === 'production';
        const simulationAllowed = !isProduction && env.ALLOW_PAYOUT_SIMULATION === 'true';

        if (!isLive && isProduction) {
          return {
            error: 'CHIP Send keys are missing on the production server. No payout was attempted. Contact admin to restore CHIP_API_KEY / CHIP_API_SECRET.',
            status: 500
          };
        }
        if (!isLive && !simulationAllowed) {
          return {
            error: 'CHIP Send keys are not configured and ALLOW_PAYOUT_SIMULATION is not "true". Refusing to fake a payout.',
            status: 500
          };
        }

        const isSimulation = !isLive && simulationAllowed;

        if (isSimulation) {
          bookings[idx].status = 'Completed - Payout Success';
          bookings[idx].payoutSuccess = true;
          bookings[idx].payoutSuccessDate = new Date().toISOString();
          bookings[idx].payoutAmount = ownerAmount;
          bookings[idx].ownerPayoutId = 'SIM_' + Date.now();
          bookings[idx].payoutMethod = 'Simulated (retry)';
          bookings[idx].payoutSimulated = true;
          bookings[idx].retriedAt = new Date().toISOString();
          bookings[idx].payoutFailedAttempt = false;
          delete bookings[idx].lastPayoutError;

          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings)).run();

          await logAction({
            db,
            action: 'payout_retry_simulated',
            admin: 'admin',
            details: `Simulated retry payout for ${bookingId} (RM${ownerAmount})`,
            ip: clientIP,
            homestayId: booking.homestayId
          });

          return {
            success: true,
            simulated: true,
            payoutId: bookings[idx].ownerPayoutId,
            amount: ownerAmount,
            bookingId
          };
        }

        // LIVE CHIP Send payout
        const reference = `KDH-${bookingId}`;

        bookings[idx].payoutAttemptedAt = new Date().toISOString();
        bookings[idx].payoutAttemptedReference = reference;
        bookings[idx].payoutAttemptedAmount = ownerAmount;

        try {
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
        } catch (preflightErr) {
          return {
            error: `Could not record the payout attempt before contacting CHIP (${preflightErr.message}). No payout was sent.`,
            status: 500
          };
        }

        const payoutResult = await chipSendPayout({
          db,
          homestayId: booking.homestayId,
          homestay,
          amount: ownerAmount,
          reference,
          description: `Retry payout for ${bookingId}`,
          env
        });

        let payoutSuccess = false;
        let payoutUnknown = false;

        if (payoutResult.success) {
          payoutSuccess = true;
          bookings[idx].status = 'Completed - Payout Success';
          bookings[idx].payoutSuccess = true;
          bookings[idx].payoutSuccessDate = new Date().toISOString();
          bookings[idx].payoutAmount = ownerAmount;
          bookings[idx].ownerPayoutId = payoutResult.payoutId;
          bookings[idx].payoutMethod = 'CHIP Send (retry)';
          bookings[idx].retriedAt = new Date().toISOString();
          bookings[idx].payoutFailedAttempt = false;
          delete bookings[idx].lastPayoutError;
        } else if (payoutResult.unknown) {
          payoutUnknown = true;
          bookings[idx].payoutUnknown = true;
          bookings[idx].payoutUnknownAt = new Date().toISOString();
          bookings[idx].payoutUnknownError = payoutResult.error;
          bookings[idx].status = 'Completed - Payout Unknown';
        } else {
          bookings[idx].payoutFailedAttempt = true;
          bookings[idx].lastPayoutError = payoutResult.error;
        }

        // ATOMIC WRITE: booking + platform-fee in ONE batch.
        let feeEarningsToWrite = null;
        if (payoutSuccess) {
          try {
            const feeRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_fee_earnings').first();
            let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
            feeEarnings.history = feeEarnings.history || [];
            const alreadyRecorded = feeEarnings.history.some(h => h.bookingId === bookingId && h.type === 'earning');
            if (!alreadyRecorded) {
              const gatewayFeeVal = (booking.gatewayFee === undefined || booking.gatewayFee === null)
                ? GATEWAY_FEE
                : Number(booking.gatewayFee);
              const feeToRecord = (Number(booking.fee) || 0) + gatewayFeeVal;
              if (feeToRecord > 0) {
                feeEarnings.total = (feeEarnings.total || 0) + feeToRecord;
                feeEarnings.available = (feeEarnings.available || 0) + feeToRecord;
                feeEarnings.history.push({
                  bookingId,
                  fee: feeToRecord,
                  date: new Date().toISOString(),
                  type: 'earning',
                  payoutToOwner: ownerAmount,
                  method: 'chip_send_retry',
                  ip: clientIP
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
          db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings))
        ];
        if (feeEarningsToWrite) {
          atomicStmts.push(
            db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
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
          action: 'payout_retried',
          admin: 'admin',
          details: `Retried payout for ${bookingId}: ${payoutResult.payoutId || 'failed'} (RM${ownerAmount})`,
          ip: clientIP,
          homestayId: booking.homestayId
        });

        return payoutSuccess
          ? {
              success: true,
              payoutId: payoutResult.payoutId,
              amount: ownerAmount,
              bookingId
            }
          : {
              success: false,
              message: payoutUnknown
                ? `Payout status UNKNOWN. Verify reference ${reference} in CHIP dashboard.`
                : `Retry failed: ${payoutResult.error}`,
              bookingId,
              payoutUnknown
            };
      }, 60000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        return jsonResponse({ error: 'Another booking operation is in progress. Please wait.' }, 429, request);
      }
      throw lockErr;
    }

    if (result.error) {
      return jsonResponse({ error: result.error }, result.status || 400, request);
    }
    return jsonResponse(result, 200, request);

  } catch (e) {
    console.error('Retry payout error:', e.message);
    return jsonResponse({ error: 'Retry payout failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
