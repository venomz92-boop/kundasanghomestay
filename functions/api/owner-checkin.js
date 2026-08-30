// /api/owner-checkin.js – CHIP Send with correct HMAC-SHA512(epoch + api_key)
import { corsHeaders, getClientIP, logAction, enforceHttps, getOwnerSession, jsonResponse } from './_utils.js';

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
    'MAYBANK': 'MBBEMYKL',
    'CIMB': 'CIMBMYKL',
    'PUBLIC BANK': 'PBBEMYKL',
    'RHB': 'RHBMYKL',
    'HONG LEONG': 'HLBBMYKL',
    'BANK ISLAM': 'BIMBMYKL',
    'BANK RAKYAT': 'BKRMMYKL',
    'BSN': 'BSNMYLKL',
    'HSBC': 'HSBCMYKL',
    'STANDARD CHARTERED': 'SCBLMYKL'
  };
  const clean = (bankName || '').toUpperCase().trim();
  for (const [key, code] of Object.entries(map)) {
    if (clean.includes(key) || key.includes(clean)) return code;
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
      return jsonResponse({ error: 'Check‑in code must be exactly 6 digits' }, 400, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Database unavailable' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const storeRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (storeRes?.data) bookings = JSON.parse(storeRes.data); } catch (_) {}
    const booking = bookings.find(b => String(b.id) === String(bookingId));
    if (!booking) return jsonResponse({ error: 'Booking not found' }, 404, request);

    const allowedIds = (ownerData.homestayIds || [ownerData.ownerId]).map(String);
    if (!allowedIds.includes(String(booking.homestayId))) {
      return jsonResponse({ error: 'Unauthorized – you do not own this homestay' }, 403, request);
    }

    if (booking.payoutSuccessDate || booking.status === 'Completed') {
      return jsonResponse({
        success: false,
        message: `Booking already completed on ${booking.payoutSuccessDate || booking.checkedInAt || 'unknown date'}`
      }, 200, request);
    }
    if (!booking.status || !booking.status.toLowerCase().includes('paid')) {
      return jsonResponse({ error: 'Booking is not paid yet' }, 400, request);
    }

    if (!booking.checkinCode || booking.checkinCode !== checkinCode) {
      return jsonResponse({ error: 'Invalid check‑in code. Please ask the guest for the 6‑digit code.' }, 400, request);
    }

    let homestay = await getHomestay(db, booking.homestayId);
    if (!homestay) {
      return jsonResponse({ error: 'Homestay not found. Cannot pay owner.' }, 404, request);
    }

    const ownerAmount = Number(booking.base || 0);
    if (ownerAmount <= 0) {
      return jsonResponse({ error: 'Invalid owner amount (RM0).' }, 400, request);
    }

    const apiKey = env.CHIP_API_KEY;
    const apiSecret = env.CHIP_SECRET_KEY;
    if (!apiKey) return jsonResponse({ error: 'CHIP_API_KEY not configured' }, 500, request);
    if (!apiSecret) return jsonResponse({ error: 'CHIP_SECRET_KEY not configured for Send' }, 500, request);

    let bankCode = getChipBankCode(homestay.ownerBank || homestay.ownerBankCode || 'MAYBANK');
    let accountNumber = (homestay.ownerBankAccount || '').replace(/[^0-9]/g, '');
    let accountName = homestay.bankHolder || homestay.ownerName || 'Owner';
    let bankAccountId = homestay.chip_bank_account_id || null;

    if (!accountNumber || accountNumber.length < 10) {
      return jsonResponse({ error: 'Owner bank account missing or invalid.' }, 400, request);
    }

    if (!bankAccountId) {
      const createRes = await fetch('https://api.chip-in.asia/api/send/bank_accounts/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          bank_code: bankCode,
          account_number: accountNumber,
          account_name: accountName
        })
      });
      const bankData = await createRes.json();
      if (!createRes.ok || !bankData.id) {
        console.error('CHIP bank account creation failed:', bankData);
        return jsonResponse({ error: 'Failed to create owner bank account. Contact support.' }, 500, request);
      }
      bankAccountId = bankData.id;
      await saveBankAccountId(db, booking.homestayId, bankAccountId);
    }

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

    const payoutData = await payoutRes.json();

    if (!payoutRes.ok || !payoutData.id) {
      console.error('CHIP Send failed:', payoutData);
      return jsonResponse({ error: 'Owner payout failed. Please try again.' }, 502, request);
    }

    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx !== -1) {
      bookings[idx].status = 'Completed - Payout Success';
      bookings[idx].chip_payout_id = payoutData.id;
      bookings[idx].payoutAmount = ownerAmount;
      bookings[idx].payoutDate = new Date().toISOString();
      bookings[idx].checkedInAt = new Date().toISOString();
      bookings[idx].checkedInBy = 'owner';
      bookings[idx].homestaySource = 'kd_approved';
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
    }

    try {
      const feeRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_fee_earnings').first();
      let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
      if (!feeEarnings.history?.some(h => h.bookingId === bookingId)) {
        const yourFee = (booking.fee || 0) + (booking.gatewayFee || 0);
        if (yourFee > 0) {
          feeEarnings.total += yourFee;
          feeEarnings.available += yourFee;
          feeEarnings.history.push({
            bookingId,
            fee: yourFee,
            date: new Date().toISOString(),
            type: 'earning',
            payoutToOwner: ownerAmount,
            method: 'chip_send'
          });
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_fee_earnings', JSON.stringify(feeEarnings))
            .run();
        }
      }
    } catch (_) {}

    await logAction({
      db,
      action: 'owner_checkin_chip_payout',
      admin: 'owner',
      details: `Check‑in ${bookingId}, CHIP payout ${payoutData.id}`,
      ip: getClientIP(request),
      userId: booking.guestEmail,
      homestayId: booking.homestayId
    });

    return jsonResponse({
      success: true,
      message: `Check‑in confirmed! RM${ownerAmount.toFixed(2)} sent to owner via CHIP Send.`,
      bookingId,
      payoutId: payoutData.id
    }, 200, request);

  } catch (e) {
    console.error('Owner check‑in error:', e.message);
    return jsonResponse({ error: 'Check‑in failed: ' + e.message }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
