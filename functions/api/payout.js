// /api/payout.js — Admin-only emergency payout using the shared
// chipSendPayout() helper. Refuses to simulate unless non-prod with
// ALLOW_PAYOUT_SIMULATION=true. Uses the global bookings lock.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  verifyAdminAuth,
  checkRateLimit,
  recordRateLimit,
  parseJSONSafely,
  jsonResponse,
  withLock,
  chipSendPayout
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';

const GATEWAY_FEE = 1.00;

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const body = await parseJSONSafely(request);
    const { bookingId } = body;

    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const isAdmin = await verifyAdminAuth(request, env);
    if (!isAdmin) {
      return jsonResponse({ error: 'Unauthorized – admin access only' }, 401, request);
    }

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Database not configured' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const rateOk = await checkRateLimit(db, clientIP, 'payout', 5, 5 * 60);
    if (!rateOk) return jsonResponse({ error: 'Too many attempts. Wait 5 minutes.' }, 429, request);
    await recordRateLimit(db, clientIP, 'payout');

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let bookings = [];
        try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx === -1) return { error: 'Booking not found', status: 404 };

        const booking = bookings[idx];

        if (booking.payoutSuccessDate || booking.ownerPayoutId ||
            (booking.payoutDate && booking.payoutSuccess === true)) {
          return {
            success: true,
            alreadyPaid: true,
            message: `Booking ${bookingId} already paid.`,
            payoutAmount: booking.payoutAmount || null,
            ownerPayoutId: booking.ownerPayoutId || null
          };
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

        const payoutAmount = Number(booking.base);
        if (!Number.isFinite(payoutAmount) || payoutAmount <= 0) {
          return { error: 'Invalid booking base amount', status: 400 };
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

        const isLive = !!(env.CHIP_API_KEY && env.CHIP_API_SECRET);
        const isProduction = env.ENVIRONMENT === 'production';
        const simulationAllowed = !isProduction && env.ALLOW_PAYOUT_SIMULATION === 'true';

        if (!isLive && isProduction) {
          return {
            error: 'Payout gateway configuration missing on production server. Set CHIP_API_KEY / CHIP_API_SECRET before retrying. No money was moved.',
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
          bookings[idx].payoutAmount = payoutAmount;
          bookings[idx].ownerPayoutId = 'SIM_' + Date.now();
          bookings[idx].payoutMethod = 'Simulated (admin override)';
          bookings[idx].payoutSimulated = true;
          bookings[idx].payoutFailedAttempt = false;
          delete bookings[idx].lastPayoutError;

          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          await logAction({
            db,
            action: 'payout_simulated_admin',
            admin: 'admin',
            details: `Simulated payout for ${bookingId} (RM${payoutAmount})`,
            ip: clientIP,
            userId: booking.guestEmail,
            homestayId: booking.homestayId
          });

          return {
            success: true,
            message: `SIMULATED payout of RM${payoutAmount.toFixed(2)} recorded. No real money was transferred.`,
            payoutId: bookings[idx].ownerPayoutId,
            bookingId,
            simulated: true
          };
        }

        // LIVE CHIP Send payout
        const reference = `KDH-${bookingId}`;

        bookings[idx].payoutAttemptedAt = new Date().toISOString();
        bookings[idx].payoutAttemptedReference = reference;
        bookings[idx].payoutAttemptedAmount = payoutAmount;

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
          amount: payoutAmount,
          reference,
          description: `Admin payout for ${bookingId}`,
          env
        });

        let payoutSuccess = false;
        let payoutUnknown = false;

        if (payoutResult.success) {
          payoutSuccess = true;
          bookings[idx].status = 'Completed - Payout Success';
          bookings[idx].chip_payout_id = payoutResult.payoutId;
          bookings[idx].ownerPayoutId = payoutResult.payoutId;
          bookings[idx].payoutAmount = payoutAmount;
          bookings[idx].payoutDate = new Date().toISOString();
          bookings[idx].payoutSuccessDate = new Date().toISOString();
          bookings[idx].payoutSuccess = true;
          bookings[idx].checkedInAt = bookings[idx].checkedInAt || new Date().toISOString();
          bookings[idx].checkedInBy = 'admin';
          bookings[idx].payoutMethod = 'CHIP Send (admin override)';
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
              const yourFee = (Number(booking.fee) || 0) + gatewayFeeVal;
              if (yourFee > 0) {
                feeEarnings.total = (feeEarnings.total || 0) + yourFee;
                feeEarnings.available = (feeEarnings.available || 0) + yourFee;
                feeEarnings.history.push({
                  bookingId,
                  fee: yourFee,
                  date: new Date().toISOString(),
                  type: 'earning',
                  payoutToOwner: payoutAmount,
                  method: 'chip_send_admin_override'
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
          action: payoutSuccess ? 'payout_chip_send_admin' : (payoutUnknown ? 'payout_chip_send_admin_unknown' : 'payout_chip_send_admin_failed'),
          admin: 'admin',
          details: `CHIP payout ${payoutResult.payoutId || 'failed'} for ${bookingId} (RM${payoutAmount})`,
          ip: clientIP,
          userId: booking.guestEmail,
          homestayId: booking.homestayId
        });

        return payoutSuccess
          ? {
              success: true,
              message: `RM${payoutAmount.toFixed(2)} sent to owner via CHIP Send.`,
              payoutId: payoutResult.payoutId,
              bookingId
            }
          : {
              success: false,
              message: payoutUnknown
                ? `Payout status UNKNOWN. Verify reference ${reference} in CHIP dashboard before retrying.`
                : `Payout failed: ${payoutResult.error}`,
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
    console.error('Payout error:', e.message);
    return jsonResponse({ error: 'Payout failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestGet({ request }) {
  return new Response(JSON.stringify({ message: 'CHIP Send Payout API ready (admin-only)' }), {
    status: 200,
    headers: corsHeaders(request)
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
