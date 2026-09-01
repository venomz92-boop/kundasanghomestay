// /api/payout.js – CHIP Send with correct credentials
import { corsHeaders, getClientIP, logAction, enforceHttps, getAdminToken, getOwnerSession, checkRateLimit, recordRateLimit, parseJSONSafely } from './_utils.js';

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

// ===== CHIP Bank code mapping (BIC/SWIFT codes) =====
function getChipBankCode(bankName) {
  const map = {
    'MAYBANK': 'MBBEMYKL',
    'CIMB': 'CIBBMYKL',      // ✅ Fixed: CIMB BIC is CIBBMYKL
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
  return 'MBBEMYKL'; // Default to Maybank
}

async function verifyPayoutAuth(request, env, bookingId) {
  const adminToken = await getAdminToken(request);
  if (adminToken && adminToken === env.ADMIN_TOKEN) return { authorized: true, role: 'admin' };
  const ownerData = await getOwnerSession(request, env);
  if (ownerData && ownerData.type === 'owner') {
    const db = env.DB;
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
    const booking = bookings.find(b => String(b.id) === String(bookingId));
    if (!booking) return { authorized: false, error: 'Booking not found' };
    const ownerHomestayIds = (ownerData.homestayIds || [ownerData.ownerId]).map(String);
    if (!ownerHomestayIds.includes(String(booking.homestayId))) {
      return { authorized: false, error: 'You do not own this homestay' };
    }
    return { authorized: true, role: 'owner', booking };
  }
  return { authorized: false, error: 'Unauthorized' };
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
    const body = await parseJSONSafely(request);
    const { bookingId, amount, fee, ownerBankCode, ownerAcc, ownerName, homestayId } = body;

    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const auth = await verifyPayoutAuth(request, env, bookingId);
    if (!auth.authorized) return jsonResponse({ error: auth.error || 'Unauthorized' }, 401, request);

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Database not configured' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const rateOk = await checkRateLimit(db, clientIP, 'payout', 5, 5 * 60);
    if (!rateOk) return jsonResponse({ error: 'Too many attempts. Wait 5 minutes.' }, 429, request);

    const payoutAmount = Number(amount);
    if (!payoutAmount || payoutAmount <= 0) return jsonResponse({ error: 'Invalid amount' }, 400, request);
    const cleanOwnerAcc = String(ownerAcc || '').replace(/[^0-9]/g, '');
    if (!cleanOwnerAcc || cleanOwnerAcc.length < 10) {
      return jsonResponse({ error: 'Invalid bank account (must be at least 10 digits)' }, 400, request);
    }
    if (!ownerName) return jsonResponse({ error: 'Missing owner name' }, 400, request);

    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx !== -1 && bookings[idx].payoutDate) {
      return jsonResponse({
        success: true,
        warning: true,
        message: `Booking ${bookingId} already paid on ${bookings[idx].payoutDate}`,
        alreadyPaid: true
      }, 200, request);
    }

    await recordRateLimit(db, clientIP, 'payout');

    let bankCode = ownerBankCode || 'MBBEMYKL';
    let accountName = ownerName;
    let accountNumber = cleanOwnerAcc;
    let bankAccountId = null;
    let booking = null;
    if (idx !== -1) booking = bookings[idx];

    if (!homestayId && booking) {
      const homestay = await getHomestay(db, booking.homestayId);
      if (homestay) {
        bankCode = getChipBankCode(homestay.ownerBank || homestay.ownerBankCode || bankCode);
        accountName = homestay.bankHolder || homestay.ownerName || ownerName;
        accountNumber = homestay.ownerBankAccount?.replace(/[^0-9]/g, '') || cleanOwnerAcc;
        bankAccountId = homestay.chip_bank_account_id || null;
      }
    } else if (homestayId) {
      const homestay = await getHomestay(db, homestayId);
      if (homestay) {
        bankCode = getChipBankCode(homestay.ownerBank || homestay.ownerBankCode || bankCode);
        accountName = homestay.bankHolder || homestay.ownerName || ownerName;
        accountNumber = homestay.ownerBankAccount?.replace(/[^0-9]/g, '') || cleanOwnerAcc;
        bankAccountId = homestay.chip_bank_account_id || null;
      }
    }

    // ===== CHIP Send credentials =====
    const apiKey = env.CHIP_API_KEY;
    const apiSecret = env.CHIP_API_SECRET;

    if (!apiKey) return jsonResponse({ error: 'CHIP_API_KEY not configured' }, 500, request);
    if (!apiSecret) return jsonResponse({ error: 'CHIP_API_SECRET not configured' }, 500, request);

    // Create bank account if not exists
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
        return jsonResponse({ error: 'Failed to create owner bank account' }, 500, request);
      }
      bankAccountId = bankData.id;
      if (booking) await saveBankAccountId(db, booking.homestayId, bankAccountId);
    }

    // Execute payout
    const amountCents = Math.round(payoutAmount * 100);
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

    // Update booking
    if (idx !== -1) {
      bookings[idx].status = 'Completed - Payout Success';
      bookings[idx].chip_payout_id = payoutData.id;
      bookings[idx].payoutAmount = payoutAmount;
      bookings[idx].payoutDate = new Date().toISOString();
      bookings[idx].checkedInAt = new Date().toISOString();
      bookings[idx].checkedInBy = auth.role === 'admin' ? 'admin' : 'owner';
      bookings[idx].chip_bank_code = bankCode;
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
    }

    // Record fee earnings
    try {
      const feeRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_fee_earnings').first();
      let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
      if (!feeEarnings.history?.some(h => h.bookingId === bookingId)) {
        const yourFee = (Number(fee) || 0) + 1.00;
        if (yourFee > 0) {
          feeEarnings.total += yourFee;
          feeEarnings.available += yourFee;
          feeEarnings.history.push({
            bookingId,
            fee: yourFee,
            date: new Date().toISOString(),
            type: 'earning',
            payoutToOwner: payoutAmount,
            method: 'chip_send'
          });
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_fee_earnings', JSON.stringify(feeEarnings))
            .run();
        }
      }
    } catch (e) { console.warn('Fee recording error:', e.message); }

    await logAction({
      db,
      action: 'payout_chip_send',
      admin: auth.role,
      details: `CHIP payout ${payoutData.id} for ${bookingId}`,
      ip: clientIP,
      userId: bookings[idx]?.guestEmail,
      homestayId: bookings[idx]?.homestayId
    });

    return jsonResponse({
      success: true,
      message: `RM${payoutAmount.toFixed(2)} sent to owner via CHIP Send.`,
      payoutId: payoutData.id,
      bookingId
    }, 200, request);

  } catch (e) {
    console.error('Payout error:', e.message);
    return jsonResponse({ error: 'Payout failed: ' + e.message }, 500, request);
  }
}

export async function onRequestGet({ request, env }) {
  return new Response(JSON.stringify({ message: 'CHIP Send Payout API ready' }), { status: 200, headers: corsHeaders(request) });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
