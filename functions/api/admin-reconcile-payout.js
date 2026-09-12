// /api/admin-reconcile-payout.js
//
// After an admin has manually confirmed in the CHIP dashboard that a
// payout with reference KDH-<bookingId> either DID NOT happen or DID
// happen outside the system, this endpoint clears the stuck markers
// on the booking so check-in / retry can proceed cleanly.
//
// Two modes:
//   mode = "no-payout"     → CHIP shows NO payout exists. Clear all
//                            attempt markers so the admin can retry
//                            from scratch.
//   mode = "paid-manually" → CHIP shows the payout DID happen but our
//                            system lost the result. Record the payout
//                            ID and mark the booking as paid out (no
//                            new CHIP Send call is made). The platform
//                            fee for the booking is recorded too, so
//                            the earnings ledger stays accurate.
//
// Admin-only. Uses the shared 'bookings-global' lock.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  verifyAdminAuth,
  jsonResponse,
  parseJSONSafely,
  withLock
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';
const GATEWAY_FEE = 1.00;

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const isAdmin = await verifyAdminAuth(request, env);
    if (!isAdmin) {
      return jsonResponse({ error: 'Unauthorized – admin access only' }, 401, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB unavailable' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const body = await parseJSONSafely(request);
    const bookingId = String(body.bookingId || '').trim();
    const mode = String(body.mode || '').trim();
    const confirmation = String(body.confirmation || '').trim();
    const manualPayoutId = body.payoutId ? String(body.payoutId).trim() : '';

    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    if (mode !== 'no-payout' && mode !== 'paid-manually') {
      return jsonResponse({ error: 'mode must be "no-payout" or "paid-manually"' }, 400, request);
    }
    if (confirmation !== `CLEARED-${bookingId}`) {
      return jsonResponse({
        error: `You must type exactly "CLEARED-${bookingId}" in the confirmation field. This confirms you have already verified the CHIP dashboard.`
      }, 400, request);
    }
    if (mode === 'paid-manually' && !manualPayoutId) {
      return jsonResponse({
        error: 'When recording a manual payout, you must supply the CHIP payout ID from the dashboard.'
      }, 400, request);
    }

    const clientIP = getClientIP(request);

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let bookings = [];
        try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
        const idx = bookings.findIndex(b => String(b.id) === bookingId);
        if (idx === -1) return { error: 'Booking not found', status: 404 };

        const before = { ...bookings[idx] };

        // Refuse if nothing is stuck. Prevents accidental state changes.
        const hasUnknown = before.payoutUnknown === true;
        const hasAttemptOnly = !!before.payoutAttemptedAt
          && !before.payoutSuccessDate
          && !before.ownerPayoutId;
        const hasFailedAttempt = before.payoutFailedAttempt === true;

        if (!hasUnknown && !hasAttemptOnly && !hasFailedAttempt) {
          return {
            error: 'This booking has no stuck payout markers to clear. Nothing to do.',
            status: 400
          };
        }

        if (mode === 'paid-manually' && before.payoutSuccessDate) {
          return {
            error: 'This booking already has payoutSuccessDate set. It is already recorded as paid.',
            status: 400
          };
        }

        let feeEarningsToWrite = null;

        if (mode === 'no-payout') {
          // Clear every marker so a fresh attempt can run cleanly.
          delete bookings[idx].payoutUnknown;
          delete bookings[idx].payoutUnknownAt;
          delete bookings[idx].payoutUnknownError;
          delete bookings[idx].payoutAttemptedAt;
          delete bookings[idx].payoutAttemptedReference;
          delete bookings[idx].payoutAttemptedAmount;
          delete bookings[idx].payoutFailedAttempt;
          delete bookings[idx].lastPayoutError;

          if (String(bookings[idx].status || '').startsWith('Completed - Payout Unknown')) {
            bookings[idx].status = 'Completed - Payout Pending';
          }

          bookings[idx].reconciledAt = new Date().toISOString();
          bookings[idx].reconciledMode = 'no-payout';
          bookings[idx].reconciledBy = 'admin';
        } else {
          // paid-manually: record the payout that already happened at CHIP.
          bookings[idx].status = 'Completed - Payout Success';
          bookings[idx].payoutSuccess = true;
          bookings[idx].payoutSuccessDate = before.payoutSuccessDate || new Date().toISOString();
          bookings[idx].payoutAmount = before.payoutAttemptedAmount || before.base || 0;
          bookings[idx].ownerPayoutId = manualPayoutId;
          bookings[idx].payoutMethod = 'CHIP Send (reconciled manually)';
          bookings[idx].payoutFailedAttempt = false;
          bookings[idx].payoutUnknown = false;
          delete bookings[idx].payoutUnknownAt;
          delete bookings[idx].payoutUnknownError;
          delete bookings[idx].lastPayoutError;
          if (!bookings[idx].checkedInAt) {
            bookings[idx].checkedInAt = new Date().toISOString();
            bookings[idx].checkedInBy = 'admin-reconcile';
          }
          bookings[idx].reconciledAt = new Date().toISOString();
          bookings[idx].reconciledMode = 'paid-manually';
          bookings[idx].reconciledBy = 'admin';

          // Record the platform fee (only if not already recorded).
          try {
            const feeRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_fee_earnings').first();
            let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
            feeEarnings.history = feeEarnings.history || [];
            const alreadyRecorded = feeEarnings.history.some(h => h.bookingId === bookingId && h.type === 'earning');
            if (!alreadyRecorded) {
              const gw = (before.gatewayFee === undefined || before.gatewayFee === null)
                ? GATEWAY_FEE
                : Number(before.gatewayFee);
              const feeToRecord = (Number(before.fee) || 0) + gw;
              if (feeToRecord > 0) {
                feeEarnings.total = (feeEarnings.total || 0) + feeToRecord;
                feeEarnings.available = (feeEarnings.available || 0) + feeToRecord;
                feeEarnings.history.push({
                  bookingId,
                  fee: feeToRecord,
                  date: new Date().toISOString(),
                  type: 'earning',
                  payoutToOwner: Number(before.payoutAttemptedAmount || before.base) || 0,
                  method: 'chip_send_reconciled_manual',
                  ip: clientIP
                });
                feeEarningsToWrite = feeEarnings;
              }
            }
          } catch (feeReadErr) {
            console.error('Reconcile: fee earnings read failed:', feeReadErr.message);
            return {
              error: `Could not prepare the fee entry for reconciliation (${feeReadErr.message}). No changes were saved. Please retry.`,
              status: 500
            };
          }
        }

        const stmts = [
          db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings))
        ];
        if (feeEarningsToWrite) {
          stmts.push(
            db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
              .bind('kd_fee_earnings', JSON.stringify(feeEarningsToWrite))
          );
        }

        try {
          await db.batch(stmts);
        } catch (batchErr) {
          console.error('Reconcile batch failed:', batchErr.message);
          return {
            error: `Could not persist reconciliation (${batchErr.message}). No changes were saved. Please retry.`,
            status: 500
          };
        }

        return { success: true, before, after: bookings[idx] };
      }, 30000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        return jsonResponse({ error: 'Another booking operation is in progress. Please wait and try again.' }, 429, request);
      }
      throw lockErr;
    }

    if (result.error) {
      return jsonResponse({ error: result.error }, result.status || 400, request);
    }

    await logAction({
      db,
      action: mode === 'no-payout' ? 'payout_reconciled_no_payout' : 'payout_reconciled_paid_manually',
      admin: 'admin',
      details: `Booking ${bookingId} reconciled (mode: ${mode}${manualPayoutId ? ', payoutId: ' + manualPayoutId : ''})`,
      ip: clientIP,
      homestayId: result.after.homestayId
    });

    return jsonResponse({
      success: true,
      mode,
      bookingId,
      message: mode === 'no-payout'
        ? `Cleared all payout markers for ${bookingId}. You can now retry the payout from scratch.`
        : `Recorded manual payout for ${bookingId} with ID ${manualPayoutId}. Platform fee ledger updated.`
    }, 200, request);

  } catch (e) {
    console.error('admin-reconcile-payout error:', e.message);
    return jsonResponse({ error: 'Reconciliation failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
