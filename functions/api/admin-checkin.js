// /api/admin-checkin.js
//
// Admin-only check-in. This is the backup path for when a host cannot
// use their own dashboard to confirm a guest's arrival — e.g. they are
// offline, their phone is dead, or their session expired and they can't
// log back in.
//
// Behaviour matches owner-checkin.js exactly, except:
//   - Auth is verifyAdminAuth() instead of getOwnerSession().
//   - The check-in code is verified the same way (guest's 6-digit code).
//   - In PAYOUT_MODE=manual, queues the booking for manual payout.
//   - In PAYOUT_MODE=auto, fires CHIP Send via the same helper.
//
// All actions are logged with admin=admin so you can tell admin-initiated
// check-ins apart from host-initiated ones in the audit trail.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  verifyAdminAuth,
  jsonResponse,
  parseJSONSafely,
  withLock,
  chipSendPayout,
  sendHostPayoutEmail
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';
const GATEWAY_FEE = 1.00;
const CHIP_PAYMENT_FEE = 1.00;

async function requireAdmin(request, env) {
  const ok = await verifyAdminAuth(request, env);
  if (!ok) return jsonResponse({ error: 'Unauthorized' }, 401, request);
  return null;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;

  let body;
  try { body = await parseJSONSafely(request); } catch (_) {
    return jsonResponse({ error: 'Invalid JSON' }, 400, request);
  }

  const bookingId = String(body.bookingId || '').trim();
  const checkinCode = String(body.checkinCode || '').trim();

  if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);
  if (!/^\d{6}$/.test(checkinCode)) {
    return jsonResponse({ error: 'Check-in code must be exactly 6 digits' }, 400, request);
  }

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'Database unavailable' }, 500, request);
  await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

  const clientIP = getClientIP(request);
  const payoutMode = String(env.PAYOUT_MODE || 'auto').toLowerCase().trim();
  const isManualMode = payoutMode === 'manual';

  let result;
  try {
    result = await withLock(db, BOOKINGS_LOCK, async (db) => {
      const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      let bookings = [];
      try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
      const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
      if (idx === -1) return { error: 'Booking not found', status: 404 };
      const booking = bookings[idx];

      // Idempotency
      if (booking.payoutSuccessDate || booking.ownerPayoutId || booking.manualPayoutPending || booking.manualPayoutCompletedAt) {
        return {
          alreadyProcessed: true,
          message: booking.manualPayoutPending
            ? 'This booking is already queued for manual payout.'
            : 'This booking has already been processed.',
          bookingId,
          payoutAmount: booking.payoutAmount || booking.manualPayoutAmount || booking.base || null
        };
      }

      // Must be paid to check in
      if (!booking.status || !booking.status.toLowerCase().includes('paid')) {
        return { error: 'Booking is not paid yet.', status: 400 };
      }

      // Verify the guest's 6-digit code
      if (!booking.checkinCode) {
        return { error: 'No check-in code on file for this booking.', status: 400 };
      }
      if (booking.checkinCode !== checkinCode) {
        return { error: 'Invalid check-in code. Ask the host to forward the code the guest received.', status: 400 };
      }

      // Find homestay (bank details + receipt info)
      let homestay = null;
      let homestaySource = null;
      for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
        const rr = await db.prepare('SELECT data FROM store WHERE key = ?').bind(store).first();
        let list = [];
        try { if (rr?.data) list = JSON.parse(rr.data); } catch (_) {}
        const found = list.find(h => String(h.id) === String(booking.homestayId));
        if (found) { homestay = found; homestaySource = store; break; }
      }
      if (!homestay) return { error: 'Homestay not found for this booking.', status: 404 };

      const ownerAmount = Number(booking.base) || 0;
      if (ownerAmount <= 0) return { error: 'Invalid booking base amount.', status: 400 };

      // ============================================================
      // MANUAL MODE — mirrors owner-checkin.js
      // ============================================================
      if (isManualMode) {
        const nowIso = new Date().toISOString();

        bookings[idx] = {
          ...booking,
          status: 'Completed - Payout Pending (Manual)',
          checkedInAt: nowIso,
          checkedInBy: 'admin',
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

        // Ledger: platform fee earnings
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
                method: 'admin_manual_checkin',
                ip: clientIP
              });
              feeEarningsToWrite = feeEarnings;
            }
          }
        } catch (e) { console.error('admin-checkin: fee earnings error:', e.message); }

        // Ledger: CHIP Collect cost
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
              ip: clientIP
            });
            chipCostsToWrite = chipCosts;
          }
        } catch (e) { console.error('admin-checkin: chip costs error:', e.message); }

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
          console.error('admin-checkin batch failed:', batchErr.message);
          return { error: `Could not record check-in: ${batchErr.message}`, status: 500 };
        }

        await logAction({
          db,
          action: 'admin_checkin_manual_queued',
          admin: 'admin',
          details: `Admin check-in for ${bookingId} confirmed. Payout RM${ownerAmount.toFixed(2)} to ${homestay.ownerName || 'host'} queued for manual bank transfer.`,
          ip: clientIP,
          userId: booking.guestEmail,
          homestayId: booking.homestayId
        });

        return {
          success: true,
          manualQueue: true,
          message: `Check-in confirmed. Host payout of RM${ownerAmount.toFixed(2)} queued for manual processing. Open the Manual Payout Queue to record the bank transfer.`,
          bookingId,
          payoutAmount: ownerAmount
        };
      }

      // ============================================================
      // AUTO MODE — fire CHIP Send
      // ============================================================
      const isLive = !!(env.CHIP_API_KEY && env.CHIP_API_SECRET);
      const isProduction = env.ENVIRONMENT === 'production';
      const simulationAllowed = !isProduction && env.ALLOW_PAYOUT_SIMULATION === 'true';

      if (!isLive && isProduction) {
        return { error: 'Payout gateway not configured on production server. Contact admin.', status: 500 };
      }
      if (!isLive && !simulationAllowed) {
        return { error: 'Payout gateway not configured and simulation not allowed.', status: 500 };
      }

      if (!isLive && simulationAllowed) {
        const simPaidAt = new Date().toISOString();
        bookings[idx] = {
          ...booking,
          status: 'Completed - Payout Success',
          payoutSuccess: true,
          payoutSuccessDate: simPaidAt,
          payoutAmount: ownerAmount,
          payoutMethod: 'Simulated (admin)',
          ownerPayoutId: 'SIM_' + Date.now(),
          checkedInAt: simPaidAt,
          checkedInBy: 'admin',
          payoutSimulated: true,
          homestaySource
        };
        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(bookings))
          .run();
        return {
          success: true,
          message: `Check-in confirmed. SIMULATED payout of RM${ownerAmount.toFixed(2)} recorded.`,
          bookingId,
          simulation: true
        };
      }

      const reference = `KDH-${bookingId}`;
      bookings[idx].payoutAttemptedAt = new Date().toISOString();
      bookings[idx].payoutAttemptedReference = reference;
      bookings[idx].payoutAttemptedAmount = ownerAmount;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      const payoutResult = await chipSendPayout({
        db,
        homestayId: booking.homestayId,
        homestay,
        amount: ownerAmount,
        reference,
        description: `Admin check-in payout for ${bookingId}`,
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
        bookings[idx] = {
          ...bookings[idx],
          status: 'Completed - Payout Success',
          payoutSuccess: true,
          payoutSuccessDate: paidAtIso,
          payoutAmount: ownerAmount,
          payoutMethod: 'CHIP Send (admin)',
          ownerPayoutId: payoutId,
          checkedInAt: paidAtIso,
          checkedInBy: 'admin',
          homestaySource
        };
      } else if (payoutResult.unknown) {
        payoutUnknown = true;
        bookings[idx] = {
          ...bookings[idx],
          status: 'Completed - Payout Unknown',
          checkedInAt: new Date().toISOString(),
          checkedInBy: 'admin',
          payoutUnknown: true,
          payoutUnknownAt: new Date().toISOString(),
          payoutUnknownError: payoutResult.error,
          homestaySource
        };
      } else {
        bookings[idx] = {
          ...bookings[idx],
          status: 'Completed - Payout Pending',
          checkedInAt: new Date().toISOString(),
          checkedInBy: 'admin',
          payoutFailedAttempt: true,
          lastPayoutError: payoutResult.error,
          homestaySource
        };
      }

      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      if (payoutSuccess) {
        try {
          await sendHostPayoutEmail(
            bookings[idx],
            homestay,
            { amount: ownerAmount, payoutId, reference, paidAt: paidAtIso },
            env
          );
        } catch (mailErr) { console.error('admin-checkin payout email error:', mailErr.message); }
      }

      await logAction({
        db,
        action: payoutSuccess ? 'admin_checkin_payout_success'
              : (payoutUnknown ? 'admin_checkin_payout_unknown' : 'admin_checkin_payout_failed'),
        admin: 'admin',
        details: `Admin check-in for ${bookingId}: ${payoutSuccess ? 'payout sent ' + payoutId : (payoutUnknown ? 'payout UNKNOWN' : 'payout failed: ' + payoutResult.error)}`,
        ip: clientIP,
        userId: booking.guestEmail,
        homestayId: booking.homestayId
      });

      return {
        success: payoutSuccess,
        message: payoutSuccess
          ? `Check-in confirmed. Payout of RM${ownerAmount.toFixed(2)} sent via CHIP Send.`
          : (payoutUnknown
              ? `Check-in confirmed, but payout status is UNKNOWN. Check CHIP dashboard.`
              : `Check-in confirmed, but payout failed: ${payoutResult.error}`),
        bookingId,
        payoutSuccess,
        payoutUnknown
      };
    }, 60000);
  } catch (lockErr) {
    if (lockErr.message && lockErr.message.includes('in progress')) {
      return jsonResponse({ error: 'Another operation is in progress. Please try again.' }, 429, request);
    }
    throw lockErr;
  }

  if (result.error) {
    return jsonResponse({ error: result.error }, result.status || 400, request);
  }
  return jsonResponse(result, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
