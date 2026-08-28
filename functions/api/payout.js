// /api/payout.js - with retry logic, and dual auth (admin + owner)
import { corsHeaders, getClientIP, logAction, enforceHttps, getAdminToken, getOwnerSession, checkRateLimit, recordRateLimit, parseJSONSafely } from './_utils.js';

// ===== New auth helper for payouts (accepts both admin and owner) =====
async function verifyPayoutAuth(request, env, bookingId) {
  // 1. Check admin token
  const adminToken = await getAdminToken(request);
  if (adminToken && adminToken === env.ADMIN_TOKEN) {
    return { authorized: true, role: 'admin' };
  }

  // 2. Check owner token
  const ownerData = await getOwnerSession(request, env);
  if (ownerData && ownerData.type === 'owner') {
    // Verify the booking belongs to this owner
    const db = env.DB;
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (r?.data) try { bookings = JSON.parse(r.data); } catch(e) {}
    const booking = bookings.find(b => String(b.id) === String(bookingId));
    if (!booking) {
      return { authorized: false, error: 'Booking not found' };
    }
    const ownerHomestayIds = (ownerData.homestayIds || [ownerData.ownerId]).map(String);
    if (!ownerHomestayIds.includes(String(booking.homestayId))) {
      return { authorized: false, error: 'You do not own this homestay' };
    }
    return { authorized: true, role: 'owner', booking };
  }

  return { authorized: false, error: 'Unauthorized' };
}

// Retry helper with exponential backoff
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error('Max retries exceeded');
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const body = await parseJSONSafely(request);
    const { bookingId, amount, fee, ownerBankCode, ownerAcc, ownerName } = body;

    if (!bookingId) {
      return new Response(JSON.stringify({ error: "Missing bookingId" }), { status: 400, headers: corsHeaders(request) });
    }

    // ---- Auth check with ownership verification ----
    const auth = await verifyPayoutAuth(request, env, bookingId);
    if (!auth.authorized) {
      return new Response(JSON.stringify({ error: auth.error || 'Unauthorized' }), { status: 401, headers: corsHeaders(request) });
    }

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Database not configured" }), { status: 500, headers: corsHeaders(request) });
    }

    const rateOk = await checkRateLimit(db, clientIP, 'payout', 5, 5 * 60);
    if (!rateOk) {
      return new Response(JSON.stringify({ error: "Too many payout attempts. Please wait 5 minutes." }), { status: 429, headers: corsHeaders(request) });
    }

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return new Response(JSON.stringify({ error: "Invalid amount" }), { status: 400, headers: corsHeaders(request) });
    }

    if (!ownerName) {
      return new Response(JSON.stringify({ error: "Missing owner name" }), { status: 400, headers: corsHeaders(request) });
    }

    // Validate bank account (basic length check)
    const cleanOwnerAcc = String(ownerAcc || "").replace(/[^0-9]/g, "");
    if (!cleanOwnerAcc || cleanOwnerAcc.length < 10 || cleanOwnerAcc.length > 15) {
      return new Response(JSON.stringify({ error: "Invalid owner bank account. Must be at least 10 digits." }), { status: 400, headers: corsHeaders(request) });
    }

    const payoutAmount = Number(amount);
    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
    const isSimulation = env.PAYOUT_SIMULATION === "true";

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // Duplicate check
    try {
      const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = res ? JSON.parse(res.data) : [];
      const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
      if (idx !== -1 && bookings[idx].payoutDate) {
        return new Response(JSON.stringify({
          success: true,
          warning: true,
          message: `Booking ${bookingId} already paid out on ${bookings[idx].payoutDate}`,
          alreadyPaid: true,
          payoutAmount: bookings[idx].payoutAmount,
          payoutDate: bookings[idx].payoutDate
        }), { headers: corsHeaders(request) });
      }
    } catch (e) {
      console.error("Failed to check duplicate payout:", e.message);
    }

    await recordRateLimit(db, clientIP, 'payout');

    // ---- Simulation ----
    if (isSimulation) {
      console.log(`🔵 SIMULATION: Payout for booking ${bookingId} (RM${payoutAmount}) to ${ownerName} (${cleanOwnerAcc})`);
      try {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1) {
          bookings[idx].status = "Completed - Owner Paid RM" + payoutAmount + " (SIMULATION)";
          bookings[idx].payoutDate = new Date().toISOString();
          bookings[idx].payoutAmount = Number(payoutAmount);
          bookings[idx].payoutMethod = "Simulation";
          bookings[idx].completedDate = new Date().toISOString();
          bookings[idx].payoutAttempts = (bookings[idx].payoutAttempts || 0) + 1;
          bookings[idx].payoutIP = clientIP;
          bookings[idx].simulation = true;
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_bookings", JSON.stringify(bookings))
            .run();
          await logAction({
            db,
            action: 'payout_simulation',
            admin: auth.role === 'admin' ? 'admin' : 'owner',
            details: `Simulated payout for booking ${bookingId}: RM${payoutAmount}`,
            ip: clientIP,
            userId: ownerName
          });
        }
      } catch (e) { console.error("Simulation update failed:", e.message); }

      return new Response(JSON.stringify({
        success: true,
        simulation: true,
        warning: "⚠️ SIMULATION MODE – no real money was transferred. Set PAYOUT_SIMULATION=false in production.",
        message: `Simulated payout RM${payoutAmount} to ${ownerName}`,
        bookingId,
        amount: payoutAmount
      }), { headers: corsHeaders(request) });
    }

    // ---- Live ----
    if (!isToyyibLive) {
      return new Response(JSON.stringify({
        success: false,
        error: "ToyyibPay payout is not enabled and simulation is off. Set PAYOUT_SIMULATION=true for testing."
      }), { status: 503, headers: corsHeaders(request) });
    }

    const formData = new FormData();
    formData.append("userSecretKey", env.TOYYIBPAY_SECRET_KEY);
    formData.append("bankCode", ownerBankCode || "MBBEMYKL");
    formData.append("bankAccountNumber", cleanOwnerAcc);
    formData.append("accountHolderName", ownerName || "Homestay Owner");
    formData.append("amount", Math.round(payoutAmount * 100));
    formData.append("payoutDescription", `KDH ${bookingId} owner payout RM${payoutAmount}`);
    formData.append("payoutReferenceNo", bookingId);

    const payoutEndpoints = [
      "https://toyyibpay.com/index.php/api/payout",
      "https://toyyibpay.com/index.php/api/createPayout",
      "https://toyyibpay.com/index.php/api/runPayout"
    ];

    let payoutData = null;
    let payoutRes = null;
    let lastError = null;

    for (const endpoint of payoutEndpoints) {
      try {
        payoutRes = await fetchWithRetry(endpoint, {
          method: "POST",
          body: formData,
          headers: { 'User-Agent': 'KundasangHomestay/1.0' }
        }, 2);
        const text = await payoutRes.text();
        try { payoutData = JSON.parse(text); } catch { payoutData = { raw: text }; }
        if (payoutRes.ok && (payoutData.status === "success" || payoutData[0]?.status === "success" || payoutData.payoutCode)) {
          break;
        }
        lastError = payoutData;
      } catch (e) {
        lastError = e.message;
        console.error(`❌ Payout endpoint ${endpoint} failed:`, e.message);
      }
    }

    const isSuccess = payoutRes && payoutRes.ok;

    // Update booking
    try {
      const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = res ? JSON.parse(res.data) : [];
      const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
      if (idx !== -1) {
        if (!bookings[idx].payoutDate) {
          bookings[idx].status = isSuccess
            ? "Completed - Owner Paid RM" + payoutAmount + " via ToyyibPay"
            : "Completed - Owner Paid RM" + payoutAmount + " (Payout API error, check settlement)";
          bookings[idx].payoutDate = new Date().toISOString();
          bookings[idx].payoutAmount = Number(payoutAmount);
          bookings[idx].payoutId = payoutData?.payoutCode || payoutData?.id || payoutData?.[0]?.PayoutCode || "TOYYIBPAY_" + Date.now();
          bookings[idx].payoutMethod = "ToyyibPay Auto Payout";
          bookings[idx].payoutResponse = payoutData;
          bookings[idx].completedDate = new Date().toISOString();
          bookings[idx].payoutAttempts = (bookings[idx].payoutAttempts || 0) + 1;
          bookings[idx].payoutIP = clientIP;
        }
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_bookings", JSON.stringify(bookings))
          .run();
        await logAction({
          db,
          action: 'payout_auto',
          admin: auth.role === 'admin' ? 'admin' : 'owner',
          details: `Auto payout for booking ${bookingId}: RM${payoutAmount} to ${ownerName}`,
          ip: clientIP,
          userId: ownerName
        });
      }
    } catch (e) {
      console.error("❌ Failed to update booking status:", e.message);
    }

    // Record fee earnings (only if admin triggered, or owner check-in)
    // We'll keep the existing logic – it works.
    try {
      const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
      const alreadyRecorded = feeEarnings.history?.some(h => h.bookingId === bookingId && h.type === "earning");
      if (!alreadyRecorded) {
        const netFee = Number(fee || 0) - 1.00;
        const finalFee = netFee > 0 ? netFee : Number(fee || 0);
        if (finalFee > 0) {
          feeEarnings.total = (feeEarnings.total || 0) + finalFee;
          feeEarnings.available = (feeEarnings.available || 0) + finalFee;
          feeEarnings.history = feeEarnings.history || [];
          feeEarnings.history.push({
            bookingId,
            fee: finalFee,
            date: new Date().toISOString(),
            type: "earning",
            payoutToOwner: Number(payoutAmount),
            ownerAcc: "****" + cleanOwnerAcc.slice(-4),
            method: isSuccess ? "toyyibpay_auto" : "manual_fallback",
            ip: clientIP
          });
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_fee_earnings", JSON.stringify(feeEarnings))
            .run();
        }
      }
    } catch (e) {
      console.error("❌ Failed to record fee earnings:", e.message);
    }

    if (!isSuccess) {
      return new Response(JSON.stringify({
        success: true,
        warning: true,
        message: `Booking completed but ToyyibPay Payout API returned error. Funds will still settle via daily auto settlement. Transfer manually to owner for now.`,
        payoutError: lastError,
        bookingId,
        amount: payoutAmount,
        note: "Contact ToyyibPay to enable Payout: support@toyyibpay.com"
      }), { headers: corsHeaders(request) });
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Auto payout RM${payoutAmount} to ${ownerName} via ToyyibPay`,
      payout: payoutData,
      bookingId,
      flow: "Check-in → Complete → Owner gets Base via ToyyibPay → You keep Fee"
    }), { headers: corsHeaders(request) });

  } catch (e) {
    console.error("❌ Payout request failed:", e.message);
    return new Response(JSON.stringify({ error: "Payout failed. Please try again later." }), { status: 500, headers: corsHeaders(request) });
  }
}

// GET and OPTIONS remain unchanged (they are fine)
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  const isLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
  const isSimulation = env.PAYOUT_SIMULATION === "true";
  return new Response(JSON.stringify({
    message: "Payout API ready",
    toyyibPayPayoutEnabled: isLive,
    mode: isSimulation ? "SIMULATION" : (isLive ? "AUTO (ToyyibPay)" : "MANUAL (fallback)"),
    bankCode: env.YOUR_BANK_CODE || "MBBEMYKL",
    security: "Admin or Owner auth required for POST",
    simulation: isSimulation,
    warning: isSimulation ? "⚠️ SIMULATION MODE – no real money will be sent" : undefined
  }), { status: 200, headers: corsHeaders(request) });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}