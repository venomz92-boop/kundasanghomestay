// /api/retry-payout.js — Admin retries failed CHIP Send payouts + records platform fee
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  getAdminToken,
  jsonResponse,
  parseJSONSafely,
  withLock
} from './_utils.js';

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
    const auth = await getAdminToken(request);
    if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
      return jsonResponse({ error: 'Unauthorized' }, 401, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB unavailable' }, 500, request);

    const body = await parseJSONSafely(request);
    const bookingId = body.bookingId;
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ============================================================
    // Use the SAME lock key as owner-checkin/payout so no two payout
    // paths can race on the same booking.
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
        if (booking.payoutSuccessDate || booking.ownerPayoutId) {
          return { success: true, alreadyPaid: true, message: 'Already paid out.' };
        }
        if (!booking.checkedInAt) {
          return { error: 'Cannot retry payout before check-in.', status: 400 };
        }

        // Find homestay
        let homestay = null;
        for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
          const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind(store).first();
          let list = [];
          try { if (rr?.data) list = JSON.parse(rr.data); } catch(_) {}
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
        if (!apiKey || !apiSecret) return { error: 'CHIP Send not configured', status: 500 };

        const chipBankCode = getChipBankCode(homestay.ownerBank || homestay.bankCode || '');

        let bankAccountId = homestay.chip_bank_account_id || null;
        if (!bankAccountId) {
          const epoch = Math.floor(Date.now() / 1000);
          const bankBody = JSON.stringify({
            bank_code: chipBankCode,
            account_number: ownerAcc,
            account_name: ownerName
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
            return { error: 'Failed to create bank account: ' + (bankData.error || 'unknown'), status: 502 };
          }
          bankAccountId = bankData.id;

          for (const store of ['kd_approved', 'kd_homestays']) {
            const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind(store).first();
            let list = [];
            try { if (rr?.data) list = JSON.parse(rr.data); } catch(_) {}
            const hIdx = list.findIndex(h => String(h.id) === String(booking.homestayId));
            if (hIdx !== -1) {
              list[hIdx].chip_bank_account_id = bankAccountId;
              await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
                .bind(store, JSON.stringify(list)).run();
              break;
            }
          }
        }

        const amountCents = Math.round(ownerAmount * 100);
        const reference = `KDH-${bookingId}`;
        const payoutPayload = {
          bank_account_id: bankAccountId,
          amount: amountCents,
          reference: reference,
          description: `Retry payout for ${bookingId}`
        };
        const epoch = Math.floor(Date.now() / 1000);
        const checksum = await hmacSha512(`${epoch}${apiKey}`, apiSecret);

        const payoutRes = await fetch('https://api.chip-in.asia/api/send/payouts/', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'epoch': String(epoch),
            'checksum': checksum
          },
          body: JSON.stringify(payoutPayload)
        });
        const payoutData = await payoutRes.json();

        if (!payoutRes.ok || !payoutData.id) {
          return { error: 'CHIP Send failed: ' + (payoutData.error || 'unknown'), status: 502 };
        }

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

        // Record platform fee (idempotent)
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
                ip: getClientIP(request)
              });
              await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
                .bind('kd_fee_earnings', JSON.stringify(feeEarnings)).run();
            }
          }
        } catch (e) { /* best-effort */ }

        await logAction({
          db,
          action: 'payout_retried',
          admin: 'admin',
          details: `Retried payout for ${bookingId}: ${payoutData.id} (RM${ownerAmount})`,
          ip: getClientIP(request),
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
        return jsonResponse({ error: 'A payout or check-in is already in progress for this booking. Please wait.' }, 429, request);
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
