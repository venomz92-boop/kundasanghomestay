// /api/owner-checkin.js – Auto check‑in + CHIP Send payout
import { corsHeaders, getClientIP, logAction, enforceHttps, getOwnerSession, jsonResponse } from './_utils.js';

// ===== CHIP Bank code mapping (BIC/SWIFT codes) =====
function getChipBankCode(bankName) {
  const map = {
    'MAYBANK': 'MBBEMYKL',
    'CIMB': 'CIBBMYKL',
    'ALLIANCE BANK': 'MFBBMYKL',
    'PUBLIC BANK': 'PBBEMYKL',
    'RHB': 'RHBMYKL',
    'HONG LEONG': 'HLBBMYKL',
    'BANK ISLAM': 'BIMBMYKL',
    'BANK RAKYAT': 'BKRMMYKL',
    'BSN': 'BSNAMYK1',
    'HSBC': 'HSBCMYKL',
    'STANDARD CHARTERED': 'SCBLMYKX'
  };
  const clean = (bankName || '').toUpperCase().trim();
  for (const [key, code] of Object.entries(map)) {
    if (clean.includes(key) || key.includes(clean)) return code;
  }
  return 'MBBEMYKL'; // Default to Maybank
}

// ===== HMAC SHA-512 helper =====
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

// ===== Helper to save bank account ID =====
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

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // 1. Authenticate owner
    const ownerData = await getOwnerSession(request, env);
    if (!ownerData || ownerData.type !== 'owner') {
      return jsonResponse({ error: 'Unauthorized' }, 401, request);
    }

    const body = await request.json();
    const bookingId = body.bookingId;
    const checkinCode = body.checkinCode;

    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }
    if (!checkinCode || !/^\d{6}$/.test(checkinCode)) {
      return jsonResponse({ error: 'Check‑in code must be exactly 6 digits' }, 400, request);
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

    // ===== 5. CHECK‑IN CODE VERIFICATION – MANDATORY =====
    if (!booking.checkinCode) {
      return jsonResponse({
        error: 'This booking does not have a check‑in code. Please ask the guest to use the "Resend Code" button in their My Bookings page to generate one.'
      }, 400, request);
    }
    if (booking.checkinCode !== checkinCode) {
      return jsonResponse({
        error: 'Invalid check‑in code. Please ask the guest for the 6‑digit code sent to their email/WhatsApp.'
      }, 400, request);
    }

    // 6. Find homestay (fallback chain)
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
    
    // ✅ Get CHIP BIC code directly (no ToyyibPay conversion)
    const bankCodeInput = homestay?.bankCode || homestay?.ownerBank || '';
    const chipBankCode = getChipBankCode(bankCodeInput);

    let payoutSuccess = false;
    let payoutData = null;
    let payoutMessage = '';
    let isSimulation = false;

    // ===== 7. Determine payout mode =====
    const isLive = !!(env.CHIP_API_KEY && env.CHIP_API_SECRET);
    const forceSimulation = env.PAYOUT_SIMULATION === 'true' || env.PAYOUT_SIMULATION === '1' || env.PAYOUT_SIMULATION === 'yes';

    // If simulation is forced OR live keys are missing → simulate
    if (forceSimulation || !isLive) {
      payoutSuccess = true;
      payoutData = { simulation: true };
      payoutMessage = forceSimulation
        ? `Check‑in confirmed! ⚠️ SIMULATED payout of RM${ownerAmount} completed (forced via PAYOUT_SIMULATION).`
        : `Check‑in confirmed! ⚠️ SIMULATED payout of RM${ownerAmount} completed (live payout keys not configured).`;
      isSimulation = true;
      console.log(`🔵 SIMULATION: Check‑in ${bookingId} – owner gets RM${ownerAmount} (simulated)`);
    } else {
      // Real payout using CHIP Send
      try {
        const apiKey = env.CHIP_API_KEY;
        const apiSecret = env.CHIP_API_SECRET;
        if (!apiKey || !apiSecret) {
          throw new Error('CHIP_API_KEY or CHIP_API_SECRET missing');
        }

        // Validate bank account
        if (!ownerAcc || ownerAcc.replace(/[^0-9]/g, '').length < 10) {
          throw new Error('Owner bank account is missing or invalid (must be at least 10 digits)');
        }
        if (!ownerName) {
          throw new Error('Owner bank account holder name is missing');
        }

        // Create or fetch bank account ID
        let bankAccountId = homestay?.chip_bank_account_id || null;
        if (!bankAccountId) {
          // Compute epoch and checksum for bank account creation
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
            throw new Error(`Failed to create bank account: ${bankData.error || 'unknown'}`);
          }
          bankAccountId = bankData.id;
          // Save for future use
          if (homestay) {
            await saveBankAccountId(db, booking.homestayId, bankAccountId);
          }
        }

        // Execute payout
        const amountCents = Math.round(ownerAmount * 100);
        const reference = `KDH-${bookingId}`;
        const payoutPayload = {
          bank_account_id: bankAccountId,
          amount: amountCents,
          reference: reference,
          description: `Owner payout for ${bookingId}`
        };

        const epoch = Math.floor(Date.now() / 1000);
        const bodyString = JSON.stringify(payoutPayload);
        const checksum = await hmacSha512(`${epoch}${apiKey}`, apiSecret);

        const payoutRes = await fetch('https://api.chip-in.asia/api/send/payouts/', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'epoch': String(epoch),
            'checksum': checksum
          },
          body: bodyString
        });

        const payoutDataRaw = await payoutRes.json();
        if (!payoutRes.ok || !payoutDataRaw.id) {
          throw new Error(`CHIP Send failed: ${payoutDataRaw.error || 'unknown'}`);
        }

        payoutSuccess = true;
        payoutData = payoutDataRaw;
        payoutMessage = `Check‑in confirmed! Payout of RM${ownerAmount} sent to owner via CHIP Send.`;
        isSimulation = false;
        console.log(`✅ Real payout ${payoutDataRaw.id} for booking ${bookingId}`);
      } catch (err) {
        console.error('Real payout failed:', err.message);
        payoutSuccess = false;
        payoutMessage = `Real payout failed: ${err.message}. Please check CHIP Send credentials and bank details.`;
      }
    }

    // ===== 8. Update booking =====
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx !== -1) {
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
        bookings[idx].chip_bank_code = chipBankCode; // Store the BIC code used
      } else {
        bookings[idx].status = 'Completed - Payout Pending';
        bookings[idx].checkedInAt = new Date().toISOString();
        bookings[idx].checkedInBy = 'owner';
        bookings[idx].payoutFailedAttempt = true;
        bookings[idx].lastPayoutError = payoutMessage;
        bookings[idx].homestaySource = homestaySource;
      }
    }

    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    // 9. Log action
    await logAction({
      db,
      action: payoutSuccess ? (isSimulation ? 'owner_checkin_simulation' : 'owner_checkin_payout_success') : 'owner_checkin_payout_failed',
      admin: 'owner',
      details: `Check‑in ${bookingId}, payout ${payoutSuccess ? (isSimulation ? 'simulated' : 'success') : 'failed'}`,
      ip: getClientIP(request),
      userId: booking.guestEmail,
      homestayId: booking.homestayId
    });

    // 10. Record fee earnings (if success)
    if (payoutSuccess) {
      try {
        const feeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
        let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
        const alreadyRecorded = feeEarnings.history?.some(h => h.bookingId === bookingId && h.type === 'earning');
        if (!alreadyRecorded) {
          const feeToRecord = (booking.fee || 0) + (booking.gatewayFee || 0);
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

    // 11. Return final response
    return jsonResponse({
      success: true,
      message: payoutMessage,
      bookingId,
      payoutSuccess,
      simulation: isSimulation,
      homestaySource,
      bankCodeUsed: chipBankCode,
      warning: isSimulation ? '⚠️ Payout was simulated (no real money transferred). To enable real payouts, set PAYOUT_SIMULATION=false and ensure CHIP_API_KEY and CHIP_API_SECRET are set.' : undefined
    }, 200, request);

  } catch (e) {
    console.error('Owner check‑in error:', e.message);
    return jsonResponse({ error: 'Check‑in failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
