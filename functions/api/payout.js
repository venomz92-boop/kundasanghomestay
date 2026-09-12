// /api/payout.js — Plain English: this admin-only emergency payout now uses
// the same global bookings lock as everything else so it can never race with
// a booking creation, check-in, or cancellation. It refuses to simulate a
// payout unless ENVIRONMENT is not "production" AND ALLOW_PAYOUT_SIMULATION
// is exactly "true". Unparseable CHIP Send responses are treated as UNKNOWN
// (needs manual verification), never as a definitive failure that would
// allow a duplicate retry. Platform fee is only recorded on a REAL,
// confirmed success.
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
  withLock
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';

async function hmacSha512(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

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
    'TOUCH N GO': 'TNGDMYNB',
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

async function getHomestay(db, homestayId) {
  if (!homestayId) return null;
  for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(store).first();
    let list = [];
    try { if (r?.data) list = JSON.parse(r.data); } catch (_) {}
    const found = list.find(h => String(h.id) === String(homestayId));
    if (found) return found;
  }
  return null;
}

async function saveBankAccountId(db, homestayId, bankAccountId) {
  if (!homestayId) return;
  for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(store).first();
    let list = [];
    try { if (r?.data) list = JSON.parse(r.data); } catch (_) {}
    if (!Array.isArray(list) || list.length === 0) continue;
    const idx = list.findIndex(h => String(h.id) === String(homestayId));
    if (idx === -1) continue;
    list[idx].chip_bank_account_id = bankAccountId;
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind(store, JSON.stringify(list))
      .run();
  }
}

const GATEWAY_FEE = 1.00;

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const body = await parseJSONSafely(request);
    const { bookingId } = body;

    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    // ===== ADMIN-ONLY AUTH =====
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
      // C4: canonical bookings lock so this serializes with every other
      // kd_bookings writer (creation, check-in, cancellation, admin edit).
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let bookings = [];
        try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx === -1) return { error: 'Booking not found', status: 404 };

        const booking = bookings[idx];

        // Idempotency
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

        const payoutAmount = Number(booking.base);
        if (!Number.isFinite(payoutAmount) || payoutAmount <= 0) {
          return { error: 'Invalid booking base amount', status: 400 };
        }

        const homestay = await getHomestay(db, booking.homestayId);
        if (!homestay) return { error: 'Homestay not found', status: 404 };

        const bankCode = getChipBankCode(homestay.ownerBank || homestay.bankCode || '');
        const accountName = homestay.bankHolder || homestay.ownerName || '';
        const accountNumber = (homestay.ownerBankAccount || '').replace(/[^0-9]/g, '');

        if (!accountNumber || accountNumber.length < 10) {
          return { error: 'Owner bank account invalid or missing', status: 400 };
        }
        if (!accountName) {
          return { error: 'Owner bank holder name missing', status: 400 };
        }

        const apiKey = env.CHIP_API_KEY;
        const apiSecret = env.CHIP_API_SECRET;
        const isLive = !!(apiKey && apiSecret);
        const isProduction = env.ENVIRONMENT === 'production';
        const simulationAllowed = !isProduction && env.ALLOW_PAYOUT_SIMULATION === 'true';

        // ============================================================
        // C1: HARD GATE. Admin override cannot simulate in production.
        // If keys are missing in production, refuse loudly.
        // ============================================================
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

        // ============================================================
        // SIMULATION PATH (non-prod only, explicit flag)
        // ============================================================
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

        // ============================================================
        // LIVE PATH
        // ============================================================
        // STEP A: Ensure CHIP bank account exists
        let bankAccountId = homestay.chip_bank_account_id || null;
        if (!bankAccountId) {
          const bankEpoch = Math.floor(Date.now() / 1000);
          const bankBody = JSON.stringify({
            bank_code: bankCode,
            account_number: accountNumber,
            account_name: accountName
          });
          const bankChecksum = await hmacSha512(`${bankEpoch}${apiKey}`, apiSecret);

          let createRes;
          try {
            createRes = await fetch('https://api.chip-in.asia/api/send/bank_accounts/', {
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
            return { error: `Bank-account lookup failed (network). No payout was sent. Error: ${netErr.message}`, status: 502 };
          }

          let bankData = null;
          let bankParseFailed = false;
          try { bankData = await createRes.json(); } catch (_) { bankParseFailed = true; }

          if (bankParseFailed || !createRes.ok || !bankData?.id) {
            return { error: 'Failed to create owner bank account at CHIP. No payout sent.', status: 502 };
          }
          bankAccountId = bankData.id;
          await saveBankAccountId(db, booking.homestayId, bankAccountId);
        }

        // STEP B: Send payout
        const amountCents = Math.round(payoutAmount * 100);
        const reference = `KDH-${bookingId}`;
        const payoutPayload = {
          bank_account_id: bankAccountId,
          amount: amountCents,
          reference: reference,
          description: `Owner payout for ${bookingId}`
        };

        bookings[idx].payoutAttemptedAt = new Date().toISOString();
        bookings[idx].payoutAttemptedReference = reference;
        bookings[idx].payoutAttemptedAmount = payoutAmount;

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
          bookings[idx].payoutUnknown = true;
          bookings[idx].payoutUnknownAt = new Date().toISOString();
          bookings[idx].payoutUnknownError = networkErr.message || 'Network error';
          bookings[idx].status = 'Completed - Payout Unknown';
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
          return {
            error: `Payout status UNKNOWN due to network error. Check CHIP dashboard for reference ${reference} before retrying.`,
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
            return { error: `Owner payout was rejected by CHIP: ${payoutData.error || payoutData.message}`, status: 502 };
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
        bookings[idx].chip_payout_id = payoutData.id;
        bookings[idx].ownerPayoutId = payoutData.id;
        bookings[idx].payoutAmount = payoutAmount;
        bookings[idx].payoutDate = new Date().toISOString();
        bookings[idx].payoutSuccessDate = new Date().toISOString();
        bookings[idx].payoutSuccess = true;
        bookings[idx].checkedInAt = bookings[idx].checkedInAt || new Date().toISOString();
        bookings[idx].checkedInBy = 'admin';
        bookings[idx].chip_bank_code = bankCode;
        bookings[idx].payoutMethod = 'CHIP Send (admin override)';
        bookings[idx].payoutFailedAttempt = false;
        delete bookings[idx].lastPayoutError;

        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_bookings', JSON.stringify(bookings))
          .run();

        // Record platform fee (idempotent) — ONLY on real success.
        try {
          const feeRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_fee_earnings').first();
          let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
          feeEarnings.history = feeEarnings.history || [];
          if (!feeEarnings.history.some(h => h.bookingId === bookingId && h.type === 'earning')) {
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
              await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
                .bind('kd_fee_earnings', JSON.stringify(feeEarnings))
                .run();
            }
          }
        } catch (_) { /* best-effort */ }

        await logAction({
          db,
          action: 'payout_chip_send_admin',
          admin: 'admin',
          details: `CHIP payout ${payoutData.id} for ${bookingId} (RM${payoutAmount})`,
          ip: clientIP,
          userId: booking.guestEmail,
          homestayId: booking.homestayId
        });

        return {
          success: true,
          message: `RM${payoutAmount.toFixed(2)} sent to owner via CHIP Send.`,
          payoutId: payoutData.id,
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
