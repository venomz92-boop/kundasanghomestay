// /api/owner-checkin.js — Host confirms guest check-in.
//
// TWO MODES, selected by env var PAYOUT_MODE:
//
//   PAYOUT_MODE=manual  → This is the mode you use for the first 3 months.
//                         Check-in marks the booking as completed and
//                         queues the host payout for MANUAL bank transfer.
//                         No CHIP Send call. No payout code fires.
//                         The admin pays the host from their bank app,
//                         then records the reference in /admin-payouts.html.
//
//   PAYOUT_MODE=auto    → The original behavior. Fires CHIP Send (or
//                         simulation, if ENVIRONMENT != production and
//                         ALLOW_PAYOUT_SIMULATION=true).
//
// Everything else is unchanged: check-in code validation, rate limiting,
// the global bookings lock, the audit log, the atomic db.batch pattern.
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
  getOwnerHomestayIdsFresh,
  sendHostPayoutEmail,
  parseJSONSafely
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';

const GATEWAY_FEE = 1.00;
const CHIP_PAYMENT_FEE = 1.00;

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const ownerData = await getOwnerSession(request, env);
    if (!ownerData || ownerData.type !== 'owner') {
      return jsonResponse({ error: 'Unauthorized' }, 401, request);
    }

    let body;
    try {
      body = await parseJSONSafely(request);
    } catch (_) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }
    const bookingId = body.bookingId;
    const checkinCode = body.checkinCode;

    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    if (!checkinCode || !/^\d{6}$/.test(checkinCode)) {
      return jsonResponse({ error: 'Check-in code must be exactly 6 digits' }, 400, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Database unavailable' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ---- Pre-fetch for auth check (read-only, no lock needed) ----
    const storeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let preBookings = [];
    try { if (storeRes?.data) preBookings = JSON.parse(storeRes.data); } catch (_) {}
    const preBooking = preBookings.find(b => String(b.id) === String(bookingId));
    if (!preBooking) return jsonResponse({ error: 'Invalid request.' }, 400, request);

    const allowedIds = await getOwnerHomestayIdsFresh(db, ownerData);
    if (!allowedIds.map(String).includes(String(preBooking.homestayId))) {
      return jsonResponse({ error: 'Unauthorized – you do not own this homestay' }, 403, request);
    }

    // Legacy guard — carried over from the pre-manual version.
    if (preBooking.payoutUnknown) {
      return jsonResponse({
        error: `Payout for this booking is in UNKNOWN state (last attempt: ${preBooking.payoutUnknownAt || 'unknown time'}). Please contact support.`
      }, 409, request);
    }

    const payoutMode = String(env.PAYOUT_MODE || 'auto').toLowerCase().trim();
    const isManualMode = payoutMode === 'manual';

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const freshRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
        let bookings = [];
        try { if (freshRes?.data) bookings = JSON.parse(freshRes.data); } catch (_) {}
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx === -1) return { error: 'Booking not found', status: 404 };
        const booking = bookings[idx];

        // ---- Idempotency: already processed? ----
        if (booking.payoutSuccessDate || booking.ownerPayoutId || booking.manualPayoutPending || booking.manualPayoutCompletedAt) {
          return {
            alreadyPaid: true,
            message: booking.manualPayoutPending
              ? `This booking is already checked in and queued for manual payout.`
              : `Booking already completed on ${booking.payoutSuccessDate || booking.checkedInAt || booking.manualPayoutCompletedAt || 'unknown date'}.`,
            bookingId,
            payoutAmount: booking.payoutAmount || booking.manualPayoutAmount || booking.base || null,
            ownerPayoutId: booking.ownerPayoutId || booking.manualPayoutReference || null
          };
        }

        if (booking.payoutUnknown) {
          return { error: `Payout is in UNKNOWN state. Contact support.`, status: 409 };
        }

        // ---- Booking must be paid to check in ----
        if (!booking.status || !booking.status.toLowerCase().includes('paid')) {
          return { error: 'Booking is not paid yet', status: 400 };
        }

        // ---- Rate limit failed code attempts ----
        const maxAttempts = 5;
        const windowMs = 60 * 60 * 1000;
        const attempts = await getRecentCheckinAttempts(db, bookingId, windowMs);
        if (attempts >= maxAttempts) {
          return { error: 'Too many failed check-in attempts. Please wait 1 hour before retrying.', status: 429, retryAfter: 3600 };
        }

        // ---- Check-in code must be present and match ----
        if (!booking.checkinCode) {
          return {
            error: 'This booking does not have a check-in code. Please ask the guest to use the "Resend Code" button in their My Bookings page.',
            status: 400
          };
        }
        if (booking.checkinCode !== checkinCode) {
          await recordCheckinAttempt(db, bookingId);
          return { error: 'Invalid check-in code. Please ask the guest for the 6-digit code sent to their email.', status: 400 };
        }
        await clearCheckinAttempts(db, bookingId);

        // ---- Find the homestay (for bank details + receipt email) ----
        let homestay = null;
        let homestaySource = null;
        for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind(store).first();
          let list = [];
          try { if (r?.data) list = JSON.parse(r.data); } catch (_) {}
          const found = list.find(h => String(h.id) === String(booking.homestayId));
          if (found) { homestay = found; homestaySource = store; break; }
        }
        if (!homestay) return { error: 'Homestay not found for this booking', status: 404 };

        const ownerAmount = Number(booking.base) || 0;
        if (ownerAmount <= 0) return { error: 'Invalid booking base amount', status: 400 };

        // ============================================================
        // MANUAL PAYOUT MODE — the phase you are in right now.
        // No CHIP Send. Check-in completes the booking and queues the
        // payout for the admin to pay manually from their bank app.
        // ============================================================
        if (isManualMode) {
          const nowIso = new Date().toISOString();

          bookings[idx] = {
            ...booking,
            status: 'Completed - Payout Pending (Manual)',
            checkedInAt: nowIso,
            checkedInBy: 'owner',
            manualPayoutPending: true,
            manualPayoutAmount: ownerAmount,
            manualPayoutQueuedAt: nowIso,
            manualPayoutHostName: homestay.ownerName || '',
            manualPayoutHostEmail: homestay.ownerEmail || '',
            manualPayoutBankName: homestay.ownerBank || '',
            manualPayoutBankCode: homestay.bankCode || '',
            manualPayoutAccountNumber: homestay.ownerBankAccount || '',
            manualPayoutAccountHolder: homestay.bankHolder || '',
            manualPayoutHomestayName: homestay.name || booking.homestay || '',
            homestaySource,
            payoutFailedAttempt: false,
            lastPayoutError: null
          };

          // --- Ledger: platform fee earnings (gross retained) ---
          let feeEarningsToWrite = null;
          try {
            const feeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
            let feeEarnings = feeRes && feeRes.data
              ? JSON.parse(feeRes.data)
              : { total: 0, available: 0, withdrawn: 0, history: [] };
            feeEarnings.history = feeEarnings.history || [];
            const alreadyRecorded = feeEarnings.history.some(h => h.bookingId === bookingId && h.type === 'earning');
            if (!alreadyRecorded) {
              const feeToRecord = (Number(booking.fee) || 0) + (Number(booking.gatewayFee) || GATEWAY_FEE);
              if (feeToRecord > 0) {
                feeEarnings.total = Math.round(((feeEarnings.total || 0) + feeToRecord) * 100) / 100;
                feeEarnings.available = Math.round(((feeEarnings.available || 0) + feeToRecord) * 100) / 100;
                feeEarnings.history.push({
                  bookingId,
                  fee: feeToRecord,
                  date: nowIso,
                  type: 'earning',
                  payoutToOwner: ownerAmount,
                  method: 'manual_pending',
                  ip: getClientIP(request)
                });
                feeEarningsToWrite = feeEarnings;
              }
            }
          } catch (feeReadErr) {
            console.error('Manual checkin: fee earnings read failed:', feeReadErr.message);
          }

          // --- Ledger: CHIP Collect cost (the RM 1.00 CHIP charged when guest paid) ---
          let chipCostsToWrite = null;
          try {
            const chipRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_chip_costs').first();
            let chipCosts = chipRes && chipRes.data
              ? JSON.parse(chipRes.data)
              : { total: 0, history: [] };
            chipCosts.history = chipCosts.history || [];
            const alreadyRecordedChip = chipCosts.history.some(h => h.bookingId === bookingId && h.type === 'checkin');
            if (!alreadyRecordedChip) {
              chipCosts.total = Math.round(((chipCosts.total || 0) + CHIP_PAYMENT_FEE) * 100) / 100;
              chipCosts.history.push({
                bookingId,
                amount: CHIP_PAYMENT_FEE,
                payment_fee: CHIP_PAYMENT_FEE,
                refund_fee: 0,
                date: nowIso,
                type: 'checkin',
                method: 'chip_collect_payment',
                ip: getClientIP(request)
              });
              chipCostsToWrite = chipCosts;
            }
          } catch (chipReadErr) {
            console.error('Manual checkin: chip costs read failed:', chipReadErr.message);
          }

          const stmts = [
            db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_bookings', JSON.stringify(bookings))
          ];
          if (feeEarningsToWrite) {
            stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_fee_earnings', JSON.stringify(feeEarningsToWrite)));
          }
          if (chipCostsToWrite) {
            stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_chip_costs', JSON.stringify(chipCostsToWrite)));
          }

          try {
            await db.batch(stmts);
          } catch (batchErr) {
            console.error('Manual checkin batch failed:', batchErr.message);
            return { error: `Could not record check-in: ${batchErr.message}`, status: 500 };
          }

          await logAction({
            db,
            action: 'owner_checkin_manual_queued',
            admin: 'owner',
            details: `Check-in ${bookingId} confirmed. Payout RM${ownerAmount.toFixed(2)} to ${homestay.ownerName || 'host'} queued for manual bank transfer.`,
            ip: getClientIP(request),
            userId: booking.guestEmail,
            homestayId: booking.homestayId
          });

          return {
            success: true,
            manualQueue: true,
            message: `Check-in confirmed! Host payout of RM${ownerAmount.toFixed(2)} has been queued for manual processing.`,
            bookingId,
            payoutAmount: ownerAmount,
            homestaySource
          };
        }

        // ============================================================
        // AUTO MODE — original CHIP Send (or simulation) path.
        // Unchanged from the version you already have.
        // ============================================================
        const isLive = !!(env.CHIP_API_KEY && env.CHIP_API_SECRET);
        const isProduction = env.ENVIRONMENT === 'production';
        const simulationAllowed = !isProduction && env.ALLOW_PAYOUT_SIMULATION === 'true';

        if (!isLive && isProduction) {
          bookings[idx].status = 'Completed - Payout Pending';
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].payoutFailedAttempt = true;
          bookings[idx].lastPayoutError = 'Payout configuration missing in production. Contact admin.';
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
            error: 'Payout configuration missing on server. Your booking was NOT marked as paid. Please contact support.',
            status: 500
          };
        }

        if (!isLive && simulationAllowed) {
          const simPayoutId = 'SIM_' + Date.now();
          const simPaidAt = new Date().toISOString();
          const simReference = `KDH-${bookingId}`;

          bookings[idx].status = 'Completed - Payout Success';
          bookings[idx].payoutSuccess = true;
          bookings[idx].payoutSuccessDate = simPaidAt;
          bookings[idx].payoutAmount = ownerAmount;
          bookings[idx].payoutMethod = 'Simulated';
          bookings[idx].ownerPayoutId = simPayoutId;
          bookings[idx].completedDate = simPaidAt;
          bookings[idx].checkedInAt = simPaidAt;
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].homestaySource = homestaySource;
          bookings[idx].payoutFailedAttempt = false;
          delete bookings[idx].lastPayoutError;

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          let simEmailReport = { sent: false, error: 'not attempted' };
          try {
            simEmailReport = await sendHostPayoutEmail(
              booking,
              homestay,
              { amount: ownerAmount, payoutId: simPayoutId, reference: simReference, paidAt: simPaidAt, isSimulation: true },
              env
            );
          } catch (mailErr) {
            console.error('Payout email error (simulation):', mailErr.message);
            simEmailReport = { sent: false, error: mailErr.message };
          }

          await logAction({
            db,
            action: 'owner_checkin_simulation',
            admin: 'owner',
            details: `Check-in ${bookingId}, payout SIMULATED. Payout email: ${simEmailReport.sent ? 'sent ([TEST])' : 'failed'}.`,
            ip: getClientIP(request),
            userId: booking.guestEmail,
            homestayId: booking.homestayId
          });

          return {
            success: true,
            message: `Check-in confirmed! SIMULATED payout of RM${ownerAmount} recorded.`,
            bookingId,
            payoutSuccess: true,
            simulation: true,
            payoutEmailSent: simEmailReport.sent
          };
        }

        if (!isLive && !simulationAllowed) {
          bookings[idx].status = 'Completed - Payout Pending';
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].payoutFailedAttempt = true;
          bookings[idx].lastPayoutError = 'CHIP Send keys missing and simulation not allowed.';
          bookings[idx].homestaySource = homestaySource;
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
          return { error: 'Payout gateway not configured and simulation not allowed. Contact admin.', status: 500 };
        }

        // ---------- LIVE CHIP SEND ----------
        const reference = `KDH-${bookingId}`;

        bookings[idx].payoutAttemptedAt = new Date().toISOString();
        bookings[idx].payoutAttemptedReference = reference;
        bookings[idx].payoutAttemptedAmount = ownerAmount;
        try {
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
        } catch (preflightErr) {
          return { error: `Could not record the payout attempt before contacting CHIP (${preflightErr.message}). No payout was sent.`, status: 500 };
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
        let payoutId = null;
        let paidAtIso = null;

        if (payoutResult.success) {
          payoutSuccess = true;
          payoutId = payoutResult.payoutId;
          paidAtIso = new Date().toISOString();
          bookings[idx].status = 'Completed - Payout Success';
          bookings[idx].payoutSuccess = true;
          bookings[idx].payoutSuccessDate = paidAtIso;
          bookings[idx].payoutAmount = Number(ownerAmount);
          bookings[idx].payoutMethod = 'CHIP Send';
          bookings[idx].ownerPayoutId = payoutId;
          bookings[idx].completedDate = paidAtIso;
          bookings[idx].checkedInAt = paidAtIso;
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

        let feeEarningsToWrite = null;
        let chipCostsToWrite = null;

        if (payoutSuccess) {
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
                  bookingId, fee: feeToRecord, date: new Date().toISOString(),
                  type: 'earning', payoutToOwner: Number(ownerAmount),
                  method: 'chip_send', ip: getClientIP(request)
                });
                feeEarningsToWrite = feeEarnings;
              }
            }
          } catch (e) { console.error('Live checkin: fee earnings read failed:', e.message); }

          try {
            const chipRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_chip_costs').first();
            let chipCosts = chipRes && chipRes.data ? JSON.parse(chipRes.data) : { total: 0, history: [] };
            chipCosts.history = chipCosts.history || [];
            const alreadyRecordedChip = chipCosts.history.some(h => h.bookingId === bookingId && h.type === 'checkin');
            if (!alreadyRecordedChip) {
              chipCosts.total = Math.round(((chipCosts.total || 0) + CHIP_PAYMENT_FEE) * 100) / 100;
              chipCosts.history.push({
                bookingId, amount: CHIP_PAYMENT_FEE, payment_fee: CHIP_PAYMENT_FEE,
                refund_fee: 0, date: new Date().toISOString(), type: 'checkin',
                method: 'chip_collect_payment', ip: getClientIP(request)
              });
              chipCostsToWrite = chipCosts;
            }
          } catch (e) { console.error('Live checkin: chip costs read failed:', e.message); }
        }

        const stmts = [
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
        ];
        if (feeEarningsToWrite) {
          stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_fee_earnings', JSON.stringify(feeEarningsToWrite)));
        }
        if (chipCostsToWrite) {
          stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_chip_costs', JSON.stringify(chipCostsToWrite)));
        }

        try {
          await db.batch(stmts);
        } catch (batchErr) {
          return {
            error: `Could not persist the payout result (${batchErr.message}). Verify reference ${reference} in the CHIP dashboard.`,
            status: 500
          };
        }

        let emailReport = { sent: false, error: 'not attempted' };
        if (payoutSuccess) {
          try {
            emailReport = await sendHostPayoutEmail(
              booking, homestay,
              { amount: ownerAmount, payoutId, reference, paidAt: paidAtIso },
              env
            );
          } catch (mailErr) {
            console.error('Payout email error:', mailErr.message);
            emailReport = { sent: false, error: mailErr.message };
          }
        }

        await logAction({
          db,
          action: payoutSuccess ? 'owner_checkin_payout_success'
                : (payoutUnknown ? 'owner_checkin_payout_unknown' : 'owner_checkin_payout_failed'),
          admin: 'owner',
          details: `Check-in ${bookingId}, payout ${payoutSuccess ? 'success' : (payoutUnknown ? 'UNKNOWN' : 'failed')}${payoutId ? ' id=' + payoutId : ''}.`,
          ip: getClientIP(request),
          userId: booking.guestEmail,
          homestayId: booking.homestayId
        });

        return {
          success: payoutSuccess,
          message: payoutSuccess
            ? `Check-in confirmed! Payout of RM${ownerAmount} sent to host via CHIP Send.`
            : (payoutUnknown
                ? `Check-in confirmed, but payout status is UNKNOWN. Check CHIP dashboard.`
                : `Check-in confirmed, but payout failed: ${payoutResult.error}`),
          bookingId,
          payoutSuccess,
          payoutUnknown,
          homestaySource,
          payoutEmailSent: emailReport.sent
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
    return jsonResponse(result, 200, request, { 'Cache-Control': 'no-store' });

  } catch (e) {
    console.error('Check-in error:', e.message);
    return jsonResponse({ error: 'Check-in failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
