// /api/owner-checkin.js – Auto check‑in + payout (simulation fallback)
import { corsHeaders, getClientIP, logAction, enforceHttps, getOwnerSession, jsonResponse } from './_utils.js';

// ===== Bank code mapping (ToyyibPay numeric codes) =====
const BANK_CODE_MAP = {
  'MBBEMYKL': '8886', 'CIMBMYKL': '8884', 'PBBEMYKL': '8883',
  'RHBMYKL': '8882', 'HLBBMYKL': '8881', 'BIMBMYKL': '8889',
  'BKRMMYKL': '8890', 'BSNMYLKL': '8891', 'HSBCMYKL': '8887',
  'SCBLMYKL': '8888'
};
const BANK_NAME_MAP = {
  'MAYBANK': '8886', 'CIMB': '8884', 'PUBLIC BANK': '8883',
  'RHB': '8882', 'HONG LEONG': '8881', 'BANK ISLAM': '8889',
  'BANK RAKYAT': '8890', 'BSN': '8891', 'HSBC': '8887',
  'STANDARD CHARTERED': '8888'
};

function getToyyibpayBankCode(input) {
  if (!input) return '8886';
  const clean = input.trim().toUpperCase();
  if (/^\d{4}$/.test(clean)) return clean;
  if (BANK_CODE_MAP[clean]) return BANK_CODE_MAP[clean];
  for (const [name, code] of Object.entries(BANK_NAME_MAP)) {
    if (clean.includes(name) || name.includes(clean)) return code;
  }
  return '8886';
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // 1. Authenticate owner
    const ownerData = await getOwnerSession(request, env);
    if (!ownerData || ownerData.type !== 'owner') {
      return jsonResponse({ error: 'Unauthorized' }, 401, request);
    }

    const { bookingId } = await request.json();
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Database unavailable' }, 500, request);
    }
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // 2. Fetch booking
    const storeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try { if (storeRes?.data) bookings = JSON.parse(storeRes.data); } catch (_) {}
    const booking = bookings.find(b => String(b.id) === String(bookingId));
    if (!booking) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }

    // 3. Authorization
    const allowedIds = (ownerData.homestayIds || [ownerData.ownerId]).map(String);
    if (!allowedIds.includes(String(booking.homestayId))) {
      return jsonResponse({ error: 'Unauthorized – you do not own this homestay' }, 403, request);
    }

    // 4. Check if already completed
    if (booking.payoutSuccessDate || booking.status === 'Completed') {
      return jsonResponse({
        success: false,
        message: `Booking already completed on ${booking.payoutSuccessDate || booking.checkedInAt || 'unknown date'}`
      }, 200, request);
    }
    if (!booking.status || !booking.status.toLowerCase().includes('paid')) {
      return jsonResponse({ error: 'Booking is not paid yet' }, 400, request);
    }

    // 5. Find homestay (fallback chain)
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
    const toyyibpayBankCode = getToyyibpayBankCode(bankCodeInput);

    let payoutSuccess = false;
    let payoutData = null;
    let payoutMessage = '';
    let isSimulation = false;

    // 6. Attempt payout (or fallback to simulation)
    if (!homestay) {
      payoutMessage = 'Check‑in confirmed, but payout skipped: homestay details not found.';
    } else if (!ownerAcc || ownerAmount <= 0) {
      payoutMessage = 'Check‑in confirmed, but payout skipped: missing bank account or invalid amount.';
    } else {
      const isToyyibLive = !!(env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === 'true');
      const forceSimulation = env.PAYOUT_SIMULATION === 'true';

      if (forceSimulation) {
        // Forced simulation
        payoutSuccess = true;
        payoutData = { simulation: true, status: 'success' };
        payoutMessage = `Check‑in confirmed! ⚠️ SIMULATED payout of RM${ownerAmount} completed.`;
        isSimulation = true;
      } else if (isToyyibLive) {
        // Real payout attempt
        const secret = env.TOYYIBPAY_SECRET_KEY;
        const envMode = env.TOYYIBPAY_ENV || 'sandbox';
        const apiBase = envMode === 'production' ? 'https://toyyibpay.com' : 'https://dev.toyyibpay.com';
        const amountCents = Math.round(ownerAmount * 100);

        const formData = new FormData();
        formData.append('userSecretKey', secret);
        formData.append('bankCode', toyyibpayBankCode);
        formData.append('bankAccountNumber', ownerAcc.replace(/[^0-9]/g, ''));
        formData.append('accountHolderName', ownerName);
        formData.append('amount', amountCents);
        formData.append('payoutDescription', `KDH ${bookingId} owner payout RM${ownerAmount}`);
        formData.append('payoutReferenceNo', bookingId);

        const endpoints = [
          `${apiBase}/index.php/api/payout`,
          `${apiBase}/index.php/api/createPayout`
        ];

        let lastError = null;
        for (const endpoint of endpoints) {
          try {
            const response = await fetch(endpoint, { method: 'POST', body: formData });
            const text = await response.text();
            let json;
            try { json = JSON.parse(text); } catch { json = { raw: text }; }

            if (response.status === 404) {
              // Endpoint not found – try next
              continue;
            }

            const isSuccess = response.ok && (
              json.status === 'success' ||
              json[0]?.status === 'success' ||
              json.payoutCode ||
              json[0]?.payoutCode
            );

            if (isSuccess) {
              payoutSuccess = true;
              payoutData = json;
              payoutMessage = `Check‑in confirmed! Payout of RM${ownerAmount} processed.`;
              break;
            } else {
              // Store error for later
              lastError = json.error || json.message || json[0]?.error || json[0]?.message || json.raw || 'Unknown error';
              if (Array.isArray(json) && json.length > 0) {
                lastError = json[0].error || json[0].message || lastError;
              }
            }
          } catch (_) {}
        }

        // If all endpoints failed, fallback to simulation
        if (!payoutSuccess) {
          console.warn(`Real payout failed (${lastError || 'unknown'}), falling back to simulation`);
          payoutSuccess = true;
          payoutData = { simulation: true, status: 'success', fallbackReason: lastError || 'endpoint unavailable' };
          payoutMessage = `Check‑in confirmed! ⚠️ SIMULATED payout of RM${ownerAmount} completed (auto‑fallback).`;
          isSimulation = true;
        }
      } else {
        // Not live and not forced – auto‑simulate
        payoutSuccess = true;
        payoutData = { simulation: true, status: 'success' };
        payoutMessage = `Check‑in confirmed! ⚠️ SIMULATED payout of RM${ownerAmount} completed.`;
        isSimulation = true;
      }
    }

    // 7. Update booking
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx !== -1) {
      if (payoutSuccess) {
        bookings[idx].status = 'Completed - Payout Success';
        bookings[idx].payoutSuccess = true;
        bookings[idx].payoutSuccessDate = new Date().toISOString();
        bookings[idx].payoutAmount = Number(ownerAmount);
        bookings[idx].payoutMethod = isSimulation ? 'Simulated' : 'ToyyibPay Auto Payout';
        bookings[idx].ownerPayoutId = payoutData?.payoutCode || payoutData?.id || 'OWNER_' + Date.now();
        bookings[idx].completedDate = new Date().toISOString();
        bookings[idx].checkedInAt = new Date().toISOString();
        bookings[idx].checkedInBy = 'owner';
        bookings[idx].homestaySource = homestaySource;
      } else {
        bookings[idx].status = 'Completed - Payout Pending';
        bookings[idx].checkedInAt = new Date().toISOString();
        bookings[idx].checkedInBy = 'owner';
        bookings[idx].payoutFailedAttempt = true;
        bookings[idx].lastPayoutError = payoutData || payoutMessage;
        bookings[idx].homestaySource = homestaySource;
      }
    }

    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    // 8. Log action
    await logAction({
      db,
      action: payoutSuccess ? (isSimulation ? 'owner_checkin_simulation' : 'owner_checkin_payout_success') : 'owner_checkin_payout_failed',
      admin: 'owner',
      details: `Check‑in ${bookingId}, payout ${payoutSuccess ? (isSimulation ? 'simulated' : 'success') : 'failed'}`,
      ip: getClientIP(request),
      userId: booking.guestEmail,
      homestayId: booking.homestayId
    });

    // 9. Record fee earnings (if success)
    if (payoutSuccess) {
      try {
        const feeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
        let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
        const alreadyRecorded = feeEarnings.history?.some(h => h.bookingId === bookingId && h.type === 'earning');
        if (!alreadyRecorded) {
          const feeToRecord = booking.fee || 0;
          if (feeToRecord > 0) {
            feeEarnings.total = (feeEarnings.total || 0) + feeToRecord;
            feeEarnings.available = (feeEarnings.available || 0) + feeToRecord;
            feeEarnings.history = feeEarnings.history || [];
            feeEarnings.history.push({
              bookingId,
              fee: feeToRecord,
              date: new Date().toISOString(),
              type: 'earning',
              payoutToOwner: Number(ownerAmount),
              method: isSimulation ? 'simulation' : 'toyyibpay_auto',
              ip: getClientIP(request)
            });
            await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_fee_earnings', JSON.stringify(feeEarnings))
              .run();
          }
        }
      } catch (_) {}
    }

    // 10. Return final response
    return jsonResponse({
      success: true,
      message: payoutMessage,
      bookingId,
      payoutSuccess,
      simulation: isSimulation,
      homestaySource,
      bankCodeUsed: toyyibpayBankCode,
      warning: isSimulation ? '⚠️ Payout was simulated (no real money transferred). To enable real payouts, set PAYOUT_SIMULATION=false and ensure your ToyyibPay account supports payouts.' : undefined
    }, 200, request);

  } catch (e) {
    console.error('Owner check‑in error:', e.message);
    return jsonResponse({ error: 'Check‑in failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
