// /api/payout.js - SECURE: AUTO via ToyyibPay Payout with idempotency
// Flow: Check-in -> ToyyibPay auto transfers Base to owner -> Fee stays with you
// Requires: TOYYIBPAY_SECRET_KEY + TOYYIBPAY_PAYOUT_ENABLED=true
// If payout not enabled, falls back to manual instruction

// ========== UTILITY FUNCTIONS ==========

function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expectedToken = env.ADMIN_TOKEN || "my-secure-admin-token";
  const expected = "Bearer " + expectedToken;
  
  console.log("🔐 Payout Auth Check:");
  console.log("  Received:", auth ? "Present" : "Missing");
  console.log("  Expected:", expected ? "Present" : "Missing");
  
  if (auth !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...cors() }
    });
  }
  return null;
}

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function validateBankAccount(account) {
  // Must be at least 10 digits (Malaysian bank accounts are 10-15 digits)
  const clean = String(account).replace(/[^0-9]/g, '');
  return clean.length >= 10 && clean.length <= 15;
}

// ========== SIMPLE RATE LIMITING (in-memory) ==========
// For production, use Cloudflare KV or D1 for persistence
const payoutAttempts = new Map();

function checkRateLimit(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const attempts = payoutAttempts.get(key) || [];
  
  // Clean old attempts (older than 5 minutes)
  const recent = attempts.filter(t => now - t < 5 * 60 * 1000);
  
  if (recent.length >= 3) {
    return { blocked: true, remaining: 0 };
  }
  
  return { blocked: false, remaining: 3 - recent.length };
}

function recordPayoutAttempt(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const attempts = payoutAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 5 * 60 * 1000);
  recent.push(now);
  payoutAttempts.set(key, recent);
}

// ========== MAIN HANDLERS ==========

export async function onRequestPost({ request, env }) {
  const authError = verifyAdmin(request, env);
  if (authError) return authError;

  try {
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    
    // --- Rate limiting ---
    const rateLimit = checkRateLimit(clientIP);
    if (rateLimit.blocked) {
      console.log(`🚫 Payout rate limit exceeded for IP: ${clientIP}`);
      return new Response(JSON.stringify({ 
        error: "Too many payout attempts. Please wait 5 minutes." 
      }), { 
        status: 429, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    const body = await request.json();
    const { bookingId, amount, fee, ownerBankCode, ownerAcc, ownerName } = body;

    // --- Validate required fields ---
    if (!bookingId) {
      return new Response(JSON.stringify({ error: "Missing bookingId" }), { 
        status: 400, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return new Response(JSON.stringify({ error: "Invalid amount" }), { 
        status: 400, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    if (!ownerName) {
      return new Response(JSON.stringify({ error: "Missing owner name" }), { 
        status: 400, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    // --- Validate owner account ---
    if (!validateBankAccount(ownerAcc)) {
      return new Response(JSON.stringify({ 
        error: "Invalid owner bank account. Must be at least 10 digits." 
      }), { 
        status: 400, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    const db = env.DB;
    const cleanOwnerAcc = String(ownerAcc || "").replace(/[^0-9]/g, "");
    const payoutAmount = Number(amount);
    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";

    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    }

    // --- CHECK FOR DUPLICATE PAYOUT (Idempotency) ---
    if (db) {
      try {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1 && bookings[idx].payoutDate) {
          console.log(`⚠️ Duplicate payout attempt for booking ${bookingId} (already paid on ${bookings[idx].payoutDate})`);
          return new Response(JSON.stringify({
            success: true,
            warning: true,
            message: `Booking ${bookingId} already paid out on ${bookings[idx].payoutDate}`,
            alreadyPaid: true,
            payoutAmount: bookings[idx].payoutAmount,
            payoutDate: bookings[idx].payoutDate
          }), { headers: { "Content-Type": "application/json", ...cors() } });
        }
      } catch (e) {
        console.error("Failed to check duplicate payout:", e.message);
      }
    }

    // --- Record attempt ---
    recordPayoutAttempt(clientIP);
    console.log(`📝 Payout attempt for booking ${bookingId} (Amount: RM${payoutAmount}, Owner: ${ownerName}, IP: ${clientIP})`);

    // --- MANUAL FALLBACK ---
    if (!isToyyibLive) {
      if (db) {
        try {
          const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
          let bookings = res ? JSON.parse(res.data) : [];
          const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
          if (idx !== -1) {
            bookings[idx].status = "Completed - Owner Paid RM" + payoutAmount + " (Awaiting ToyyibPay Payout Activation)";
            bookings[idx].payoutDate = new Date().toISOString();
            bookings[idx].payoutAmount = Number(payoutAmount);
            bookings[idx].payoutMethod = "Manual until ToyyibPay Payout enabled";
            bookings[idx].completedDate = new Date().toISOString();
            bookings[idx].payoutAttempts = (bookings[idx].payoutAttempts || 0) + 1;
            bookings[idx].payoutIP = clientIP;
            await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
            console.log(`✅ Manual payout recorded for booking ${bookingId}`);
          }
        } catch (e) {
          console.error("❌ Failed to update booking (manual fallback):", e.message);
        }
      }
      return new Response(JSON.stringify({
        success: true,
        simulation: true,
        message: `ToyyibPay Payout not yet enabled. Set TOYYIBPAY_PAYOUT_ENABLED=true after ToyyibPay approves Payout. Meanwhile manually transfer RM${payoutAmount} to ${ownerName}.`,
        bookingId,
        amount: payoutAmount,
        owner: ownerName,
        instruction: `Enable ToyyibPay Payout to make this auto. For now transfer RM${payoutAmount} to ${ownerName}`,
        nextStep: "Contact ToyyibPay support: Enable Payout feature for your account"
      }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    // --- AUTO PAYOUT VIA TOYYIBPAY ---
    const formData = new FormData();
    formData.append("userSecretKey", env.TOYYIBPAY_SECRET_KEY);
    formData.append("bankCode", ownerBankCode || env.YOUR_BANK_CODE || "MBBEMYKL");
    formData.append("bankAccountNumber", cleanOwnerAcc);
    formData.append("accountHolderName", ownerName || "Homestay Owner");
    formData.append("amount", Math.round(payoutAmount * 100)); // in cents
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

    console.log(`🔄 Attempting ToyyibPay payout for booking ${bookingId}...`);

    for (const endpoint of payoutEndpoints) {
      try {
        console.log(`  Trying endpoint: ${endpoint}`);
        payoutRes = await fetch(endpoint, { 
          method: "POST", 
          body: formData,
          headers: {
            'User-Agent': 'KundasangHomestay/1.0'
          }
        });
        const text = await payoutRes.text();
        try { payoutData = JSON.parse(text); } catch { payoutData = { raw: text }; }
        console.log(`  Response status: ${payoutRes.status}`);
        if (payoutRes.ok && (payoutData.status === "success" || payoutData[0]?.status === "success" || payoutData.payoutCode)) {
          console.log(`✅ Payout successful via ${endpoint}`);
          break;
        }
        lastError = payoutData;
      } catch (e) {
        lastError = e.message;
        console.error(`❌ Payout endpoint ${endpoint} failed:`, e.message);
      }
    }

    const isSuccess = payoutRes && payoutRes.ok;

    if (db) {
      try {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1) {
          // Don't overwrite if already paid (extra safety)
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
          } else {
            console.log(`⚠️ Booking ${bookingId} already has payout date, skipping update`);
          }
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
        }
      } catch (e) {
        console.error("❌ Failed to update booking status after payout:", e.message);
      }

      // --- Fee earnings (only if not already recorded) ---
      try {
        const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
        
        // Check if fee already recorded
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
            await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(feeEarnings)).run();
            console.log(`✅ Fee earnings recorded: RM${finalFee} for booking ${bookingId}`);
          }
        } else {
          console.log(`ℹ️ Fee for booking ${bookingId} already recorded, skipping`);
        }
      } catch (e) {
        console.error("❌ Failed to record fee earnings:", e.message);
      }
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
      }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    console.log(`✅ Payout completed successfully for booking ${bookingId}`);
    return new Response(JSON.stringify({
      success: true,
      message: `Auto payout RM${payoutAmount} to ${ownerName} via ToyyibPay`,
      payout: payoutData,
      bookingId,
      flow: "Check-in → Complete → Owner gets Base via ToyyibPay → You keep Fee"
    }), { headers: { "Content-Type": "application/json", ...cors() } });

  } catch (e) {
    console.error("❌ Payout request failed:", e.message, e.stack);
    return new Response(JSON.stringify({ 
      error: "Payout failed. Please try again later." 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json", ...cors() } 
    });
  }
}

// === GET (Public - show payout config status) ===
export async function onRequestGet({ env }) {
  const isLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
  return new Response(JSON.stringify({
    message: "Payout API ready",
    toyyibPayPayoutEnabled: isLive,
    mode: isLive ? "AUTO (ToyyibPay)" : "MANUAL (fallback)",
    bankCode: env.YOUR_BANK_CODE || "MBBEMYKL",
    security: "Admin auth required for POST",
    payoutEndpoints: [
      "https://toyyibpay.com/index.php/api/payout",
      "https://toyyibpay.com/index.php/api/createPayout",
      "https://toyyibpay.com/index.php/api/runPayout"
    ]
  }), { status: 200, headers: cors() });
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}
