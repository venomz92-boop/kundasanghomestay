// /api/retry-payout.js — Plain English: admin-triggered retry of a failed
// CHIP Send payout. Now uses the same global bookings lock as every other
// money-movement file, refuses to simulate in production, and treats
// unparseable/ambiguous CHIP responses as UNKNOWN (manual verification)
// rather than a definitive failure that would let a duplicate be sent.
// Platform fee is only recorded on a REAL, confirmed success.
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

function getChipBankCode(bankName) {
  const map = {
    'AEON BANK': 'ACDBMYK2',
    'AFFIN BANK': 'PHBMMYKL',
    'AGROBANK': 'AGOBMYKL',
    'AL-RAJHI': 'RJHIMYKL',
    'ALLIANCE BANK': 'MFBBMYKL',
    'AMBANK': 'ARBKMYKL',
    'BANK ISLAM': 'BIMBMYKL',
    'BANK RAKYAT': 'BKRMMYKL',
    'BANK MUAMALAT': 'BMMBMYKL',
    'BSN': 'BSNAMYK1',
    'CIMB': 'CIBBMYKL',
    'HONG LEONG': 'HLBBMYKL',
    'HSBC': 'HBMBMYKL',
    'MAYBANK': 'MBBEMYKL',
    'MBSB': 'AFBQMYKL',
    'OCBC': 'OCBCMYKL',
    'PUBLIC BANK': 'PBBEMYKL',
    'RHB': 'RHBBMYKL',
    'STANDARD CHARTERED': 'SCBLMYKX',
    'UOB': 'UOVBMYKL'
  };
  const clean = (bankName || '').toUpperCase().trim();
  if (!clean) return 'MBBEMYKL';
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  for (const [key, code] of entries) {
    if (clean.includes(key)) return code;
  }
  return 'MBBEMYKL';
}

async function hmacSha512(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

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
      // C4: canonical bookings lock. This serializes against booking
      // creation, check-in, cancellation, admin override, and admin edits.
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

        const ownerAcc = (homestay.ownerBankAccount || '').replace(/[^0-9]/g, '');
        const ownerName = homestay.bankHolder || homestay.ownerName || '';
        if (!ownerAcc || ownerAcc.length < 10) return { error: 'Invalid bank account', status: 400 };
        if (!ownerName) return { error: 'Missing bank holder name', status: 400 };

        const apiKey = env.CHIP_API_KEY;
        const apiSecret = env.CHIP_API_SECRET;
        const isLive = !!(apiKey && apiSecret);
        const isProduction = env.ENVIRONMENT === 'production';
        const simulationAllowed = !isProduction && env.ALLOW_PAYOUT_SIMULATION === 'true';

        // ============================================================
        // C1: HARD GATE. Retry cannot simulate in production.
        // ============================================================
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

        // ============================================================
        // SIMULATION PATH (non-prod only, explicit flag)
        // ============================================================
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

        // ============================================================
        // LIVE PATH
        // ============================================================
        const chipBankCode = getChipBankCode(homestay.ownerBank || homestay.bankCode || '');

        // STEP A: Ensure CHIP bank account exists
        let bankAccountId = homestay.chip_bank_account_id || null;
        if (!bankAccountId) {
          const bankEpoch = Math.floor(Date.now() / 1000);
          const bankBody = JSON.stringify({
            bank_code: chipBankCode,
            account_number: ownerAcc,
            account_name: ownerName
          });
          const bankChecksum = await hmacSha512(`${bankEpoch}${apiKey}`, apiSecret);

          let bankRes;
          try {
            bankRes = await fetch('https://api.chip-in.asia/api/send/bank_accounts/', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'epoch': String(bankEpoch),
                'checksum': bankChecksum
              },
              body: bankBody
            });
          } catch (netErr) {
            return { error: `Bank-account lookup failed (network). No payout sent. Error: ${netErr.message}`, status: 502 };
          }

          let bankData = null;
          let bankParseFailed = false;
          try { bankData = await bankRes.json(); } catch (_) { bankParseFailed = true; }

          if (bankParseFailed || !bankRes.ok || !bankData?.id) {
            return { error: 'Failed to create bank account at CHIP. No payout sent.', status: 502 };
          }
          bankAccountId = bankData.id;

          // Cache bank account ID back into all stores that carry this homestay
          for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
            const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind(store).first();
            let list = [];
            try { if (rr?.data) list = JSON.parse(rr.data); } catch (_) {}
            if (!Array.isArray(list) || list.length === 0) continue;
            const hIdx = list.findIndex(h => String(h.id) === String(booking.homestayId));
            if (hIdx === -1) continue;
            list[hIdx].chip_bank_account_id = bankAccountId;
            await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
              .bind(store, JSON.stringify(list)).run();
          }
        }

        // STEP B: Send payout
        const amountCents = Math.round(ownerAmount * 100);
        const reference = `KDH-${bookingId}`;
        const payoutPayload = {
          bank_account_id: bankAccountId,
          amount: amountCents,
          reference: reference,
          description: `Retry payout for ${bookingId}`
        };

        bookings[idx].payoutAttemptedAt = new Date().toISOString();
        bookings[idx].payoutAttemptedReference = reference;
        bookings[idx].payoutAttemptedAmount = ownerAmount;

        const payoutEpoch = Math.floor(Date.now() / 1000);
        const payoutChecksum = await hmacSha512(`${payoutEpoch}${apiKey}`, apiSecret);

        let payoutRes;
        try {
          payoutRes = await fetch('https://api.chip-in.asia/api/send/payouts/', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'epoch': String(payoutEpoch),
              'checksum': payoutChecksum
            },
            body: JSON.stringify(payoutPayload)
          });
        } catch (networkErr) {
          // Network error — CHIP may or may not have processed it
          bookings[idx].payoutUnknown = true;
          bookings[idx].payoutUnknownAt = new Date().toISOString();
          bookings[idx].payoutUnknownError = networkErr.message || 'Network error';
          bookings[idx].status = 'Completed - Payout Unknown';
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
          return {
            error: `Payout status UNKNOWN due to network error. Check CHIP dashboard for reference ${reference}.`,
            status: 502
          };
        }

        // H3: unparseable response → UNKNOWN, not definitive failure.
        let payoutData = null;
        let parseFailed = false;
        try { payoutData = await payoutRes.json(); } catch (_) { parseFailed = true; }

        if (parseFailed) {
          bookings[idx].payoutUnknown = true;
          bookings[idx].payoutUnknownAt = new Date().toISOString();
          bookings[idx].payoutUnknownError = 'Unparseable response from CHIP Send';
          bookings[idx].status = 'Completed - Payout Unknown';
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
          return {
            error: `CHIP Send returned an unparseable response. Payout status is UNKNOWN — verify reference ${reference} in the CHIP dashboard before retrying.`,
            status: 502
          };
        }

        if (!payoutRes.ok || !payoutData.id) {
          const errStr = String(payoutData?.error || payoutData?.message || '').toLowerCase();
          const isStructuredRejection = payoutRes.status >= 400 && payoutRes.status < 500 && errStr.length > 0;
          if (isStructuredRejection) {
            return { error: 'CHIP Send rejected the payout: ' + (payoutData.error || payoutData.message), status: 502 };
          }
          bookings[idx].payoutUnknown = true;
          bookings[idx].payoutUnknownAt = new Date().toISOString();
          bookings[idx].payoutUnknownError = `Ambiguous CHIP response (HTTP ${payoutRes.status})`;
          bookings[idx].status = 'Completed - Payout Unknown';
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
          return {
            error: `CHIP Send response ambiguous (HTTP ${payoutRes.status}). Status set to UNKNOWN. Verify reference ${reference} in the CHIP dashboard.`,
            status: 502
          };
        }

        // STEP C: Update booking on success
        bookings[idx].status = 'Completed - Payout Success';
        bookings[idx].payoutSuccess = true;
        bookings[idx].payoutSuccessDate = new Date().toISOString();
        bookings[idx].payoutAmount = ownerAmount;
        bookings[idx].ownerPayoutId = payoutData.id;
        bookings[idx].payoutMethod = 'CHIP Send (retry)';
        bookings[idx].retriedAt = new Date().toISOString();
        bookings[idx].payoutFailedAttempt = false;
        delete bookings[idx].lastPayoutError;

        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_bookings', JSON.stringify(bookings)).run();

        // Record platform fee (idempotent) — ONLY on real success.
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
              await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
                .bind('kd_fee_earnings', JSON.stringify(feeEarnings)).run();
            }
          }
        } catch (_) { /* best-effort */ }

        await logAction({
          db,
          action: 'payout_retried',
          admin: 'admin',
          details: `Retried payout for ${bookingId}: ${payoutData.id} (RM${ownerAmount})`,
          ip: clientIP,
          homestayId: booking.homestayId
        });

        return {
          success: true,
          payoutId: payoutData.id,
          amount: ownerAmount,
          bookingId
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
