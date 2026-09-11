// /api/payout.js – ADMIN-ONLY CHIP Send emergency payout override
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
    try { if (r?.data) list = JSON.parse(r.data); } catch(_) {}
    const found = list.find(h => String(h.id) === String(homestayId));
    if (found) return found;
  }
  return null;
}

async function saveBankAccountId(db, homestayId, bankAccountId) {
  if (!homestayId) return;
  for (const store of ['kd_approved', 'kd_homestays']) {
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(store).first();
    let list = [];
    try { if (r?.data) list = JSON.parse(r.data); } catch(_) {}
    const idx = list.findIndex(h => String(h.id) === String(homestayId));
    if (idx !== -1) {
      list[idx].chip_bank_account_id = bankAccountId;
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind(store, JSON.stringify(list))
        .run();
      break;
    }
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

    // ===== ADMIN-ONLY AUTH (signed token) =====
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

    // ============================================================
    // Use the SAME lock key as /api/owner-checkin so admin payout
    // and owner check-in cannot race for the same booking.
    // 60s stale timeout covers CHIP Send API latency.
    // ============================================================
    let result;
    try {
      result = await withLock(db, `checkin-${bookingId}`, async (db) => {
        const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let bookings = [];
        try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx === -1) return { error: 'Booking not found', status: 404 };

        const booking = bookings[idx];

        // Idempotency — any of these means owner already paid
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

        // Server-side amount: always booking.base, never from client
        const payoutAmount = Number(booking.base);
        if (!Number.isFinite(payoutAmount) || payoutAmount <= 0) {
          return { error: 'Invalid booking base amount', status: 400 };
        }

        // Fetch homestay details for bank info
        const homestay = await getHomestay(db, booking.homestayId);
        if (!homestay) return { error: 'Homestay not found', status: 404 };

        const bankCode = getChipBankCode(homestay.ownerBank || homestay.bankCode || '');
        const accountName = homestay.bankHolder || homestay.ownerName || '';
        const accountNumber = (homestay.ownerBankAccount || '').replace(/[^0-9]/g, '');
        let bankAccountId = homestay.chip_bank_account_id || null;

        if (!accountNumber || accountNumber.length < 10) {
          return { error: 'Owner bank account invalid or missing', status: 400 };
        }
        if (!accountName) {
          return { error: 'Owner bank holder name missing', status: 400 };
        }

        const apiKey = env.CHIP_API_KEY;
        const apiSecret = env.CHIP_API_SECRET;
        if (!apiKey || !apiSecret) {
          return { error: 'Payment gateway configuration missing', status: 500 };
        }
        // Block re-entry if the booking has an unresolved payout attempt
        if (booking.payoutUnknown) {
          return {
            error: `Payout state is UNKNOWN (${booking.payoutUnknownAt || 'unknown time'}). Check CHIP dashboard for reference KDH-${bookingId} before retrying.`,
            status: 409
          };
        }

        if (!bankAccountId) {
          const epoch = Math.floor(Date.now() / 1000);
          const bankBody = JSON.stringify({
            bank_code: bankCode,
            account_number: accountNumber,
            account_name: accountName
          });
          const checksum = await hmacSha512(`${epoch}${apiKey}`, apiSecret);

          const createRes = await fetch('https://api.chip-in.asia/api/send/bank_accounts/', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'epoch': String(epoch),
              'checksum': checksum
            },
            body: bankBody
          });
          const bankData = await createRes.json();
          if (!createRes.ok || !bankData.id) {
            return { error: 'Failed to create owner bank account', status: 500 };
          }
          bankAccountId = bankData.id;
          await saveBankAccountId(db, booking.homestayId, bankAccountId);
        }

        const amountCents = Math.round(payoutAmount * 100);
        const reference = `KDH-${bookingId}`;
        const payoutPayload = {
          bank_account_id: bankAccountId,
          amount: amountCents,
          reference: reference,
          description: `Owner payout for ${bookingId}`
        };

        const epoch = Math.floor(Date.now() / 1000);
        const checksum = await hmacSha512(`${epoch}${apiKey}`, apiSecret);

               // Record attempt before API call
        bookings[idx].payoutAttemptedAt = new Date().toISOString();
        bookings[idx].payoutAttemptedReference = reference;
        bookings[idx].payoutAttemptedAmount = Number(payoutAmount);

        let payoutRes;
        try {
          payoutRes = await fetch('https://api.chip-in.asia/api/send/payouts/', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'epoch': String(epoch),
              'checksum': checksum
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

        let payoutData;
        try {
          payoutData = await payoutRes.json();
        } catch (_) {
          payoutData = {};
        }

        if (!payoutRes.ok || !payoutData.id) {
          // API error — CHIP explicitly rejected. Safe to retry.
          return { error: `Owner payout failed: ${payoutData.error || 'unknown'}`, status: 502 };
        }

        // Update booking
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

        // Record platform fee (idempotent)
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
        } catch (e) { /* best-effort */ }

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
        return jsonResponse({ error: 'A payout or check-in is already in progress for this booking. Please wait.' }, 429, request);
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
