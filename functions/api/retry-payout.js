// /api/retry-payout.js — Admin retries failed CHIP Send payouts
import { corsHeaders, getClientIP, logAction, enforceHttps, getAdminToken, jsonResponse, parseJSONSafely } from './_utils.js';

async function hmacSha512(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getChipBankCode(bankName) {
  const map = {
    'MAYBANK': 'MBBEMYKL', 'CIMB': 'CIBBMYKL', 'PUBLIC BANK': 'PBBEMYKL',
    'RHB': 'RHBBMYKL', 'HONG LEONG': 'HLBBMYKL', 'BANK ISLAM': 'BIMBMYKL',
    'BANK RAKYAT': 'BKRMMYKL', 'BSN': 'BSNAMYK1', 'AMBANK': 'ARBKMYKL',
    'ALLIANCE BANK': 'MFBBMYKL', 'AFFIN BANK': 'PHBMMYKL', 'OCBC': 'OCBCMYKL',
    'HSBC': 'HBMBMYKL', 'STANDARD CHARTERED': 'SCBLMYKX', 'UOB': 'UOVBMYKL',
    'AGROBANK': 'AGOBMYKL', 'BANK MUAMALAT': 'BMMBMYKL'
  };
  const clean = (bankName || '').toUpperCase().trim();
  for (const [key, code] of Object.entries(map)) {
    if (clean.includes(key)) return code;
  }
  return 'MBBEMYKL';
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const auth = await getAdminToken(request);
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request);
  }

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB unavailable' }, 500, request);

  const body = await parseJSONSafely(request);
  const bookingId = body.bookingId;
  if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
  const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
  if (idx === -1) return jsonResponse({ error: 'Booking not found' }, 404, request);

  const booking = bookings[idx];
  if (booking.payoutSuccessDate || booking.ownerPayoutId) {
    return jsonResponse({ success: true, alreadyPaid: true, message: 'Already paid out.' }, 200, request);
  }
  if (!booking.checkedInAt) {
    return jsonResponse({ error: 'Cannot retry payout before check-in.' }, 400, request);
  }

  // Find homestay
  let homestay = null;
  for (const store of ['kd_approved', 'kd_homestays']) {
    const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind(store).first();
    let list = [];
    try { if (rr?.data) list = JSON.parse(rr.data); } catch(_) {}
    const found = list.find(h => String(h.id) === String(booking.homestayId));
    if (found) { homestay = found; break; }
  }
  if (!homestay) return jsonResponse({ error: 'Homestay not found' }, 404, request);

  const ownerAmount = booking.base || 0;
  const ownerAcc = (homestay.ownerBankAccount || '').replace(/[^0-9]/g, '');
  const ownerName = homestay.bankHolder || homestay.ownerName || '';
  if (!ownerAcc || ownerAcc.length < 10) return jsonResponse({ error: 'Invalid bank account' }, 400, request);
  if (!ownerName) return jsonResponse({ error: 'Missing bank holder' }, 400, request);

  const apiKey = env.CHIP_API_KEY;
  const apiSecret = env.CHIP_API_SECRET;
  if (!apiKey || !apiSecret) return jsonResponse({ error: 'CHIP Send not configured' }, 500, request);

  const chipBankCode = getChipBankCode(homestay.ownerBank || homestay.bankCode);

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
      return jsonResponse({ error: 'Failed to create bank account: ' + (bankData.error || 'unknown') }, 502, request);
    }
    bankAccountId = bankData.id;
    homestay.chip_bank_account_id = bankAccountId;
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
    return jsonResponse({ error: 'CHIP Send failed: ' + (payoutData.error || 'unknown') }, 502, request);
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

  await logAction({
    db,
    action: 'payout_retried',
    admin: 'admin',
    details: `Retried payout for ${bookingId}: ${payoutData.id}`,
    ip: getClientIP(request),
    homestayId: booking.homestayId
  });

  return jsonResponse({
    success: true,
    payoutId: payoutData.id,
    amount: ownerAmount,
    bookingId
  }, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
