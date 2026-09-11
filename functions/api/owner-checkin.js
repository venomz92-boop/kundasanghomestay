// /api/owner-checkin.js — Auto check-in + CHIP Send payout + brute-force protection + long lock
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
    'BANK OF AMERICA': 'BOFAMY2X',
    'BANK OF CHINA': 'BKCHMYKL',
    'BANK OF TOKYO-MITSUBISHI': 'BOTKMYKX',
    'BSN': 'BSNAMYK1',
    'BNP PARIBAS': 'BNPAMYKL',
    'CHINA CONSTRUCTION BANK': 'PCBCMYKL',
    'CIMB': 'CIBBMYKL',
    'DEUTSCHE BANK': 'DEUTMYKL',
    'FINEXUS': 'FNXSMYNB',
    'GX BANK': 'GXSPMYKL',
    'HONG LEONG': 'HLBBMYKL',
    'HSBC': 'HBMBMYKL',
    'ICBC': 'ICBKMYKL',
    'JP MORGAN': 'CHASMYKX',
    'KUWAIT FINANCE HOUSE': 'KFHOMYKL',
    'MAYBANK': 'MBBEMYKL',
    'MBSB': 'AFBQMYKL',
    'MIZUHO': 'MHCBMYKA',
    'OCBC': 'OCBCMYKL',
    'PUBLIC BANK': 'PBBEMYKL',
    'RHB': 'RHBBMYKL',
    'STANDARD CHARTERED': 'SCBLMYKX',
    'SUMITOMO MITSUI': 'SMBCMYKL',
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

    // Pre-fetch for auth check
    const storeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let preBookings = [];
    try { if (storeRes?.data) preBookings = JSON.parse(storeRes.data); } catch (_) {}
    const preBooking = preBookings.find(b => String(b.id) === String(bookingId));
    if (!preBooking) return jsonResponse({ error: 'Invalid request.' }, 400, request);

    const allowedIds = (ownerData.homestayIds || [ownerData.ownerId]).map(String);
    if (!allowedIds.includes(String(preBooking.homestayId))) {
      return jsonResponse({ error: 'Unauthorized – you do not own this homestay' }, 403, request);
    }

    // Block re-entry if a previous payout ended in unknown network state
    if (preBooking.payoutUnknown) {
      return jsonResponse({
        error: `Payout for this booking is in UNKNOWN state (last attempt: ${preBooking.payoutUnknownAt || 'unknown time'}). Please log into your CHIP dashboard and verify whether a payout with reference KDH-${bookingId} exists before contacting support.`
      }, 409, request);
    }

    let result;
    try {
      result = await withLock(db, `checkin-${bookingId}`, async (db) => {
        const freshRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
        let bookings = [];
        try { if (freshRes?.data) bookings = JSON.parse(freshRes.data); } catch (_) {}
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx === -1) return { error: 'Booking not found', status: 404 };
        const booking = bookings[idx];

        // Idempotency
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

        if (!booking.status || !booking.status.toLowerCase().includes('paid')) {
          return { error: 'Booking is not paid yet', status: 400 };
        }

        // Rate limit failed attempts
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

        // Code verification
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

        const ownerAmount = booking.base || 0;
        const ownerAcc = homestay?.ownerBankAccount || '';
        const ownerName = homestay?.bankHolder || homestay?.ownerName || '';
        const bankCodeInput = homestay?.bankCode || homestay?.ownerBank || '';
        const chipBankCode = getChipBankCode(bankCodeInput);

        let payoutSuccess = false;
        let payoutUnknown = false;
        let payoutData = null;
        let payoutMessage = '';
        let isSimulation = false;

        const isLive = !!(env.CHIP_API_KEY && env.CHIP_API_SECRET);
        const forceSimulation = env.PAYOUT_SIMULATION === 'true' || env.PAYOUT_SIMULATION === '1' || env.PAYOUT_SIMULATION === 'yes';

        if (forceSimulation || !isLive) {
          payoutSuccess = true;
          payoutData = { simulation: true };
          payoutMessage = forceSimulation
            ? `Check-in confirmed! SIMULATED payout of RM${ownerAmount} completed (forced via PAYOUT_SIMULATION).`
            : `Check-in confirmed! SIMULATED payout of RM${ownerAmount} completed (live payout keys not configured).`;
          isSimulation = true;
        } else {
          try {
            const apiKey = env.CHIP_API_KEY;
            const apiSecret = env.CHIP_API_SECRET;

            if (!ownerAcc || ownerAcc.replace(/[^0-9]/g, '').length < 10) {
              throw new Error('CHIP Send failed: Owner bank account is missing or invalid (must be at least 10 digits)');
            }
            if (!ownerName) {
              throw new Error('CHIP Send failed: Owner bank account holder name is missing');
            }

            let bankAccountId = homestay?.chip_bank_account_id || null;
            if (!bankAccountId) {
              const epoch = Math.floor(Date.now() / 1000);
              const bankBody = JSON.stringify({
                bank_code: chipBankCode,
                account_number: ownerAcc.replace(/[^0-9]/g, ''),
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
                throw new Error(`CHIP Send failed: Failed to create bank account: ${bankData.error || 'unknown'}`);
              }
              bankAccountId = bankData.id;
              if (homestay) await saveBankAccountId(db, booking.homestayId, bankAccountId);
            }

            const amountCents = Math.round(ownerAmount * 100);
            const reference = `KDH-${bookingId}`;
            const payoutPayload = {
              bank_account_id: bankAccountId,
              amount: amountCents,
              reference: reference,
              description: `Owner payout for ${bookingId}`
            };

            // Record attempt BEFORE the API call. If the call never
            // completes, we can see from the booking that a payout attempt
            // was in-flight (used for reconciliation).
            bookings[idx].payoutAttemptedAt = new Date().toISOString();
            bookings[idx].payoutAttemptedReference = reference;
            bookings[idx].payoutAttemptedAmount = Number(ownerAmount);

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

            const payoutDataRaw = await payoutRes.json();
            if (!payoutRes.ok || !payoutDataRaw.id) {
              throw new Error(`CHIP Send failed: ${payoutDataRaw.error || 'unknown'}`);
            }

            payoutSuccess = true;
            payoutData = payoutDataRaw;
            payoutMessage = `Check-in confirmed! Payout of RM${ownerAmount} sent to owner via CHIP Send.`;
            isSimulation = false;
          } catch (err) {
            payoutSuccess = false;
            const errMsg = err.message || 'unknown';
            const isApiError = /^CHIP Send failed:/.test(errMsg);

            if (isApiError) {
              // CHIP explicitly rejected. Safe to retry.
              payoutMessage = `Real payout failed: ${errMsg}. Please check CHIP Send credentials and bank details.`;
            } else {
              // Network / timeout / unknown — CHIP may or may not have processed it.
              payoutUnknown = true;
              payoutMessage = `Check-in confirmed, but payout status is UNKNOWN due to a network error. Reference KDH-${bookingId} may have been sent to CHIP. Log into your CHIP dashboard to verify before retrying.`;
            }
          }
        }

        // Update booking
        if (payoutSuccess) {
          bookings[idx].status = 'Completed - Payout Success';
          bookings[idx].payoutSuccess = true;
          bookings[idx].payoutSuccessDate = new Date().toISOString();
          bookings[idx].payoutAmount = Number(ownerAmount);
          bookings[idx].payoutMethod = isSimulation ? 'Simulated' : 'CHIP Send';
          bookings[idx].ownerPayoutId = payoutData?.id || 'SIM_' + Date.now();
          bookings[idx].completedDate = new Date().toISOString();
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].homestaySource = homestaySource;
          bookings[idx].chip_bank_code = chipBankCode;
          bookings[idx].payoutFailedAttempt = false;
          delete bookings[idx].lastPayoutError;
        } else if (payoutUnknown) {
          bookings[idx].status = 'Completed - Payout Unknown';
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].payoutUnknown = true;
          bookings[idx].payoutUnknownAt = new Date().toISOString();
          bookings[idx].payoutUnknownError = payoutMessage;
          bookings[idx].homestaySource = homestaySource;
        } else {
          bookings[idx].status = 'Completed - Payout Pending';
          bookings[idx].checkedInAt = new Date().toISOString();
          bookings[idx].checkedInBy = 'owner';
          bookings[idx].payoutFailedAttempt = true;
          bookings[idx].lastPayoutError = payoutMessage;
          bookings[idx].homestaySource = homestaySource;
        }

        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(bookings))
          .run();

        await logAction({
          db,
          action: payoutSuccess
            ? (isSimulation ? 'owner_checkin_simulation' : 'owner_checkin_payout_success')
            : (payoutUnknown ? 'owner_checkin_payout_unknown' : 'owner_checkin_payout_failed'),
          admin: 'owner',
          details: `Check-in ${bookingId}, payout ${payoutSuccess ? (isSimulation ? 'simulated' : 'success') : (payoutUnknown ? 'UNKNOWN' : 'failed')}`,
          ip: getClientIP(request),
          userId: booking.guestEmail,
          homestayId: booking.homestayId
        });

        // Record fee earnings only on confirmed success
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
                  bookingId,
                  fee: feeToRecord,
                  date: new Date().toISOString(),
                  type: 'earning',
                  payoutToOwner: Number(ownerAmount),
                  method: isSimulation ? 'simulation' : 'chip_send',
                  ip: getClientIP(request)
                });
                await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
                  .bind('kd_fee_earnings', JSON.stringify(feeEarnings))
                  .run();
              }
            }
          } catch (_) {}
        }

        return {
          success: payoutSuccess,
          message: payoutMessage,
          bookingId,
          payoutSuccess,
          payoutUnknown,
          simulation: isSimulation,
          homestaySource,
          bankCodeUsed: chipBankCode,
          warning: isSimulation
            ? 'Payout was simulated (no real money transferred).'
            : (payoutUnknown ? 'Payout state unknown. Check CHIP dashboard before retrying.' : undefined)
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
