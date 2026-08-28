// /api/owner-checkin.js - with checkinCode verification and payout fixes
import { corsHeaders, getClientIP, logAction, enforceHttps, getOwnerSession, jsonResponse } from './_utils.js';

// ===== Mapping from SWIFT/Bank Name to ToyyibPay numeric bank codes =====
const TOYYIBPAY_BANK_CODES = {
  // Malaysian banks (common)
  'MBBEMYKL': '8886',      // Maybank
  'CIMBMYKL': '8884',      // CIMB
  'PBBEMYKL': '8883',      // Public Bank
  'RHBMYKL': '8882',       // RHB
  'HLBBMYKL': '8881',      // Hong Leong
  'BIMBMYKL': '8889',      // Bank Islam
  'BKRMMYKL': '8890',      // Bank Rakyat
  'BSNMYLKL': '8891',      // BSN
  'HSBCMYKL': '8887',      // HSBC
  'SCBLMYKL': '8888',      // Standard Chartered
  // Add others as needed, or fallback to a default
};

function getToyyibpayBankCode(inputCode) {
  if (!inputCode) return '8886'; // default Maybank
  const clean = inputCode.trim().toUpperCase();
  // If it's already numeric (e.g., "8886"), return as is
  if (/^\d{4}$/.test(clean)) return clean;
  // Check mapping
  if (TOYYIBPAY_BANK_CODES[clean]) return TOYYIBPAY_BANK_CODES[clean];
  // If it's a bank name, try to match partially (for "Maybank" -> "8886")
  const nameMap = {
    'MAYBANK': '8886',
    'CIMB': '8884',
    'PUBLIC BANK': '8883',
    'RHB': '8882',
    'HONG LEONG': '8881',
    'BANK ISLAM': '8889',
    'BANK RAKYAT': '8890',
    'BSN': '8891',
    'HSBC': '8887',
    'STANDARD CHARTERED': '8888'
  };
  for (const [name, code] of Object.entries(nameMap)) {
    if (clean.includes(name) || name.includes(clean)) return code;
  }
  return '8886'; // fallback
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const ownerData = await getOwnerSession(request, env);
    if (!ownerData || ownerData.type !== 'owner') {
      return jsonResponse({ error: 'Unauthorized: Invalid or expired token' }, 401, request);
    }

    const body = await request.json();
    const bookingId = body.bookingId;
    const checkinCode = body.checkinCode;

    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // ---- 1. Get bookings ----
    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res && res.data) { try { bookings = JSON.parse(res.data); } catch(e) {} }
    const booking = bookings.find(b => String(b.id) === String(bookingId));

    if (!booking) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }

    // Authorization
    if (!(ownerData.homestayIds || [ownerData.ownerId]).map(String).includes(String(booking.homestayId))) {
      console.warn(`⚠️ Owner ${ownerData.whatsapp} tried to check-in booking for homestay ${booking.homestayId} but owns ${ownerData.ownerId}`);
      return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
    }

    // Already paid out?
    if (booking.payoutSuccessDate) {
      return jsonResponse({
        success: false,
        warning: true,
        message: `Booking ${bookingId} already paid out on ${booking.payoutSuccessDate}`
      }, 200, request);
    }

    // Payment verification
    if (!booking.status || !booking.status.toLowerCase().includes("paid")) {
      return jsonResponse({ error: 'Booking is not paid yet' }, 400, request);
    }

    // ===== CHECK-IN CODE VERIFICATION =====
    if (booking.checkinCode && booking.checkinCode !== checkinCode) {
      return jsonResponse({ error: 'Invalid check-in code. Please ask the guest for the 6-digit code sent to their WhatsApp/email.' }, 400, request);
    }

    // ---- 2. Get homestay details from multiple stores (fallback chain) ----
    let homestay = null;
    let homestaySource = null;

    const stores = ['kd_approved', 'kd_homestays', 'kd_pending'];
    for (const store of stores) {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind(store).first();
      let list = [];
      if (r && r.data) { try { list = JSON.parse(r.data); } catch(e) {} }
      const found = list.find(h => String(h.id) === String(booking.homestayId));
      if (found) {
        homestay = found;
        homestaySource = store;
        break;
      }
    }

    const ownerAmount = booking.base || 0;
    const ownerAcc = homestay?.ownerBankAccount || "";
    const ownerName = homestay?.bankHolder || homestay?.ownerName || "";
    // Get bank code: prefer bankCode if stored, else try to derive from ownerBank
    let bankCodeInput = homestay?.bankCode || homestay?.ownerBank || "";
    const toyyibpayBankCode = getToyyibpayBankCode(bankCodeInput);

    // ---- 3. Determine payout mode ----
    const isToyyibLive = !!env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
    const isSimulation = env.PAYOUT_SIMULATION === "true";

    let payoutSuccess = false;
    let payoutData = null;
    let payoutMessage = '';

    // If homestay not found, skip payout
    if (!homestay) {
      payoutMessage = 'Check‑in confirmed, but payout skipped: Homestay details not found.';
    } else if (!ownerAcc || ownerAmount <= 0) {
      payoutMessage = 'Check‑in confirmed, but payout skipped: Missing bank account or invalid amount.';
    } else if (isSimulation) {
      console.log(`🔵 SIMULATION: Payout for booking ${bookingId} (RM${ownerAmount}) to ${ownerName} (${ownerAcc})`);
      payoutSuccess = true;
      payoutData = { simulation: true, status: 'success', message: 'Simulated payout successful' };
      payoutMessage = `Check‑in confirmed! ⚠️ SIMULATED payout of RM${ownerAmount} completed (no real money sent).`;
    } else if (isToyyibLive) {
      // ---- REAL TOYYIBPAY PAYOUT ----
      const secret = env.TOYYIBPAY_SECRET_KEY;
      const envMode = env.TOYYIBPAY_ENV || 'sandbox';
      const apiBase = envMode === 'production' ? 'https://toyyibpay.com' : 'https://dev.toyyibpay.com';
      const amountCents = Math.round(ownerAmount * 100);

      const formData = new FormData();
      formData.append("userSecretKey", secret);
      formData.append("bankCode", toyyibpayBankCode);
      formData.append("bankAccountNumber", ownerAcc.replace(/[^0-9]/g, ''));
      formData.append("accountHolderName", ownerName);
      formData.append("amount", amountCents);
      formData.append("payoutDescription", `KDH ${bookingId} owner payout RM${ownerAmount}`);
      formData.append("payoutReferenceNo", bookingId);

      const endpoints = [
        `${apiBase}/index.php/api/payout`,
        `${apiBase}/index.php/api/createPayout`
      ];

      for (const endpoint of endpoints) {
        try {
          console.log(`🟢 Trying payout endpoint: ${endpoint}`);
          const response = await fetch(endpoint, { method: "POST", body: formData });
          const text = await response.text();
          console.log(`📦 Response (${response.status}):`, text);
          let json;
          try { json = JSON.parse(text); } catch { json = { raw: text }; }
          if (response.ok && (json.status === "success" || json[0]?.status === "success" || json.payoutCode || json[0]?.payoutCode)) {
            payoutSuccess = true;
            payoutData = json;
            payoutMessage = `Check‑in confirmed! Payout of RM${ownerAmount} processed.`;
            break;
          } else {
            payoutData = json;
            console.warn("Payout API error:", json);
          }
        } catch (e) {
          console.error("Payout endpoint error:", e.message);
        }
      }
      if (!payoutSuccess) {
        payoutMessage = `Check‑in confirmed, but payout failed: ${payoutData?.error || payoutData?.message || 'Unknown error'}`;
        // Additional debug info
        if (payoutData) {
          console.error("Full payout response:", JSON.stringify(payoutData));
        }
      }
    } else {
      payoutMessage = 'Check‑in confirmed, but payout is not enabled (set PAYOUT_SIMULATION=true for testing).';
    }

    // ---- 4. Update booking status ----
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx !== -1) {
      if (payoutSuccess) {
        bookings[idx].status = "Completed - Payout Success";
        bookings[idx].payoutSuccess = true;
        bookings[idx].payoutSuccessDate = new Date().toISOString();
        bookings[idx].payoutAmount = Number(ownerAmount);
        bookings[idx].payoutMethod = isSimulation ? "Simulated Owner Check-in" : "ToyyibPay Auto Payout";
        bookings[idx].ownerPayoutId = payoutData?.payoutCode || payoutData?.id || "OWNER_" + Date.now();
        bookings[idx].completedDate = new Date().toISOString();
        bookings[idx].payoutAttempts = (bookings[idx].payoutAttempts || 0) + 1;
        bookings[idx].homestaySource = homestaySource;
      } else {
        bookings[idx].status = "Completed - Payout Pending";
        bookings[idx].checkedInAt = new Date().toISOString();
        bookings[idx].checkedInBy = 'owner';
        bookings[idx].payoutFailedAttempt = true;
        bookings[idx].lastPayoutError = payoutData || payoutMessage;
        bookings[idx].homestaySource = homestaySource;
      }
    }

    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_bookings", JSON.stringify(bookings))
      .run();

    // ---- 5. Log action ----
    await logAction({
      db,
      action: payoutSuccess ? 'owner_checkin_payout_success' : 'owner_checkin_payout_skipped',
      admin: 'owner',
      details: `Check-in for ${bookingId}, payout ${payoutSuccess ? 'success' : 'skipped/failed'}${homestaySource ? ' (source: '+homestaySource+')' : ''}`,
      ip: getClientIP(request),
      userId: booking.guestEmail,
      homestayId: booking.homestayId
    });

    // ---- 6. Record fee earnings (if success) ----
    if (payoutSuccess) {
      try {
        const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
        const alreadyRecorded = feeEarnings.history?.some(h => h.bookingId === bookingId && h.type === "earning");
        if (!alreadyRecorded) {
          const finalFee = (booking.fee || 0) - (booking.gatewayFee || 0);
          const feeToRecord = finalFee > 0 ? finalFee : (booking.fee || 0);
          if (feeToRecord > 0) {
            feeEarnings.total = (feeEarnings.total || 0) + feeToRecord;
            feeEarnings.available = (feeEarnings.available || 0) + feeToRecord;
            feeEarnings.history = feeEarnings.history || [];
            feeEarnings.history.push({
              bookingId,
              fee: feeToRecord,
              date: new Date().toISOString(),
              type: "earning",
              payoutToOwner: Number(ownerAmount),
              ownerAcc: "****" + ownerAcc.slice(-4),
              method: isSimulation ? "simulation" : "toyyibpay_auto",
              ip: getClientIP(request)
            });
            await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
              .bind("kd_fee_earnings", JSON.stringify(feeEarnings))
              .run();
          }
        }
      } catch(e) {
        console.error("❌ Failed to record fee earnings:", e.message);
      }
    }

    return jsonResponse({
      success: true,
      message: payoutMessage || "Check‑in confirmed.",
      bookingId,
      payout: payoutData,
      payoutSuccess,
      simulation: isSimulation,
      homestaySource,
      bankCodeUsed: toyyibpayBankCode,
      warning: isSimulation ? '⚠️ SIMULATION MODE – set PAYOUT_SIMULATION=false for live transfers' : undefined
    }, 200, request);

  } catch (e) {
    console.error("❌ Owner check-in error:", e.message, e.stack);
    return jsonResponse({ error: 'Check-in failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
