// /api/withdraw.js - SECURE: Auth + Error Handling + RESET support + Rate Limiting
// UPDATED: Now calls ToyyibPay Payout API to actually send money to your locked bank account

// ========== UTILITY FUNCTIONS ==========

function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expectedToken = env.ADMIN_TOKEN || "";
  if (!expectedToken) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors() }
    });
  }
  const expected = "Bearer " + expectedToken;
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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function validateAmount(amount) {
  const num = Number(amount);
  if (isNaN(num) || num <= 0) return false;
  const str = String(num);
  if (str.includes('.') && str.split('.')[1].length > 2) return false;
  return true;
}

// ========== SIMPLE RATE LIMITING (in-memory) ==========
const withdrawalAttempts = new Map();

function checkRateLimit(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const attempts = withdrawalAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 5 * 60 * 1000);
  if (recent.length >= 3) {
    return { blocked: true, remaining: 0 };
  }
  return { blocked: false, remaining: 3 - recent.length };
}

function recordWithdrawalAttempt(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const attempts = withdrawalAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 5 * 60 * 1000);
  recent.push(now);
  withdrawalAttempts.set(key, recent);
}

// ========== MAIN HANDLERS ==========

// === POST (Withdraw + Reset) ===
export async function onRequestPost(context) {
  const authError = verifyAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const { request, env } = context;
    
    // --- Rate limiting (by IP) ---
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const rateLimit = checkRateLimit(clientIP);
    if (rateLimit.blocked) {
      console.log(`🚫 Withdrawal rate limit exceeded for IP: ${clientIP}`);
      return new Response(JSON.stringify({ 
        error: "Too many withdrawal attempts. Please wait 5 minutes." 
      }), { 
        status: 429, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    const LOCKED_BANK = {
      bankName: env.YOUR_BANK_NAME || "Maybank",
      bankCode: env.YOUR_BANK_CODE || "MBBEMYKL",
      accountHolder: env.YOUR_BANK_HOLDER || "Nicks Creations",
      accountNumber: env.YOUR_BANK_ACCOUNT || ""
    };

    const data = await request.json();
    const { amount, reset, action } = data || {};

    const db = env.DB;
    let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };

    if (db) {
      try {
        await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        if (r) earnings = JSON.parse(r.data);
      } catch (e) {
        console.error("❌ Failed to read fee earnings:", e.message);
        return new Response(JSON.stringify({ 
          error: "Database error. Please try again later." 
        }), { 
          status: 500, 
          headers: { "Content-Type": "application/json", ...cors() } 
        });
      }
    }

    // === RESET HANDLER ===
    if (reset === true || action === "reset") {
      const prevWithdrawn = earnings.withdrawn || 0;
      const prevAvailable = earnings.available || 0;
      const prevTotal = earnings.total || 0;
      
      earnings.withdrawn = 0;
      earnings.available = 0;
      earnings.total = 0;
      earnings.history = earnings.history || [];
      earnings.history.push({
        type: "reset",
        date: new Date().toISOString(),
        note: "FULL RESET - All to 0 by admin",
        prevWithdrawn,
        prevAvailable,
        prevTotal,
        ip: clientIP
      });

      if (db) {
        try {
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_fee_earnings", JSON.stringify(earnings))
            .run();
          console.log(`✅ Withdrawal reset by admin (IP: ${clientIP})`);
        } catch (e) {
          console.error("❌ Failed to save reset earnings:", e.message);
          return new Response(JSON.stringify({ 
            error: "Failed to reset. Please try again." 
          }), { 
            status: 500, 
            headers: { "Content-Type": "application/json", ...cors() } 
          });
        }
      }

      return new Response(JSON.stringify({
        success: true,
        message: "Withdrawn reset to RM0.00",
        earnings,
        reset: true
      }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });
    }

    // === NORMAL WITHDRAW ===
    const bankName = LOCKED_BANK.bankName;
    const accountHolder = LOCKED_BANK.accountHolder;
    const accountNumber = LOCKED_BANK.accountNumber;
    const bankCode = LOCKED_BANK.bankCode;

    // --- Validate bank account ---
    if (!accountNumber) {
      console.error("❌ Bank account not configured");
      return new Response(JSON.stringify({ 
        error: "Bank account not configured. Please contact support." 
      }), { 
        status: 500, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    // --- Validate amount ---
    if (!amount) {
      return new Response(JSON.stringify({ 
        error: "Amount is required" 
      }), { 
        status: 400, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    if (!validateAmount(amount)) {
      return new Response(JSON.stringify({ 
        error: "Invalid amount. Please enter a valid number with up to 2 decimal places." 
      }), { 
        status: 400, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    const withdrawAmount = Number(amount);
    if (withdrawAmount > (earnings.available || 0)) {
      return new Response(JSON.stringify({ 
        error: `Insufficient balance. Available: RM${(earnings.available || 0).toFixed(2)}` 
      }), { 
        status: 400, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    // --- Check for minimum withdrawal ---
    if (withdrawAmount < 10) {
      return new Response(JSON.stringify({ 
        error: "Minimum withdrawal is RM10.00" 
      }), { 
        status: 400, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    // --- Record attempt (before processing) ---
    recordWithdrawalAttempt(clientIP);

    const maskedAccount = accountNumber.slice(-4).padStart(accountNumber.length, "*");

    // =============================================================
    // ========== STEP 1: CALL TOYYIBPAY PAYOUT TO YOUR BANK ==========
    // =============================================================
    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
    let payoutSuccess = false;
    let payoutData = null;
    let payoutError = null;

    if (isToyyibLive) {
      console.log(`🔄 Initiating ToyyibPay Payout to your bank: RM${withdrawAmount} to ${accountNumber}`);

      const formData = new FormData();
      formData.append("userSecretKey", env.TOYYIBPAY_SECRET_KEY);
      formData.append("bankCode", bankCode);
      formData.append("bankAccountNumber", accountNumber.replace(/[^0-9]/g, ''));
      formData.append("accountHolderName", accountHolder);
      formData.append("amount", Math.round(withdrawAmount * 100));
      formData.append("payoutDescription", `Platform Withdrawal WD_${Date.now()}`);
      formData.append("payoutReferenceNo", `WD_${Date.now()}`);

      const endpoints = [
        "https://toyyibpay.com/index.php/api/payout",
        "https://toyyibpay.com/index.php/api/createPayout"
      ];

      for (const endpoint of endpoints) {
        try {
          console.log(`  Trying endpoint: ${endpoint}`);
          const res = await fetch(endpoint, {
            method: "POST",
            body: formData,
            headers: { 'User-Agent': 'KundasangHomestay/1.0' }
          });
          const text = await res.text();
          try { payoutData = JSON.parse(text); } catch { payoutData = { raw: text }; }
          console.log(`  Response status: ${res.status}`);
          if (res.ok && (payoutData.status === "success" || payoutData[0]?.status === "success" || payoutData.payoutCode)) {
            console.log(`✅ Withdrawal payout successful via ${endpoint}`);
            payoutSuccess = true;
            break;
          }
          payoutError = payoutData;
        } catch (e) {
          payoutError = e.message;
          console.error(`❌ Payout endpoint ${endpoint} failed:`, e.message);
        }
      }
    } else {
      // Simulation mode (ToyyibPay keys not set or payout disabled)
      console.log(`🔶 SIMULATION: Withdrawal to your bank: RM${withdrawAmount} to ${accountHolder} (${accountNumber})`);
      payoutSuccess = true;
      payoutData = { simulation: true };
    }

    // =============================================================
    // ========== STEP 2: UPDATE DATABASE ONLY IF SUCCESSFUL ==========
    // =============================================================
    if (!payoutSuccess) {
      console.error("❌ Payout to your bank failed:", payoutError);
      return new Response(JSON.stringify({
        success: false,
        error: "ToyyibPay payout to your bank failed. Please try again or check your ToyyibPay balance.",
        details: payoutError
      }), { 
        status: 500, 
        headers: { "Content-Type": "application/json", ...cors() } 
      });
    }

    // Now update the bookkeeping (safe to update since payout succeeded)
    const withdrawal = {
      id: "WD_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
      amount: withdrawAmount,
      bankName,
      bankCode,
      accountHolder,
      accountNumber: maskedAccount,
      fullAccountForPayout: "***LOCKED***",
      note: "Platform fee withdrawal - Locked to owner account",
      date: new Date().toISOString(),
      status: "Success - Sent to your bank via ToyyibPay",
      locked: true,
      ip: clientIP,
      payoutId: payoutData?.payoutCode || payoutData?.id || "AUTO_WD_" + Date.now(),
      simulation: payoutData?.simulation || false
    };

    if (db) {
      try {
        earnings.available = Math.max(0, (earnings.available || 0) - withdrawAmount);
        earnings.withdrawn = (earnings.withdrawn || 0) + withdrawAmount;
        earnings.history.push({ ...withdrawal, type: "withdrawal" });
        
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_fee_earnings", JSON.stringify(earnings))
          .run();
          
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_locked_bank", JSON.stringify({
            bankName,
            bankCode,
            accountHolder,
            accountNumber: maskedAccount,
            lastUpdated: new Date().toISOString(),
            lastWithdrawal: {
              amount: withdrawAmount,
              date: withdrawal.date,
              id: withdrawal.id,
              status: withdrawal.status
            }
          }))
          .run();
          
        console.log(`✅ Withdrawal successful: RM${withdrawAmount.toFixed(2)} (ID: ${withdrawal.id}, IP: ${clientIP})`);
      } catch (e) {
        console.error("❌ Failed to save withdrawal after successful payout:", e.message);
        // CRITICAL: We already sent the money, but failed to update DB.
        // We should log this heavily so you can manually reconcile.
        console.error("⚠️ MANUAL RECONCILIATION NEEDED: Payout sent but DB update failed for ID:", withdrawal.id);
        return new Response(JSON.stringify({ 
          error: "Payout succeeded, but failed to update records. Please check your ToyyibPay dashboard and contact support immediately.",
          payoutId: withdrawal.payoutId
        }), { 
          status: 500, 
          headers: { "Content-Type": "application/json", ...cors() } 
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `RM${withdrawAmount.toFixed(2)} sent to your bank account (${bankName} ${accountHolder}). 
                ${isToyyibLive ? 'ToyyibPay is processing the transfer.' : '(Simulation mode - no real money sent)'}`,
      withdrawal,
      earnings,
      security: "Bank details LOCKED server-side",
      simulation: payoutData?.simulation || false
    }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });

  } catch (err) {
    console.error("❌ Withdraw request failed:", err.message, err.stack);
    return new Response(JSON.stringify({ 
      error: "Withdrawal failed. Please try again later." 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json", ...cors() } 
    });
  }
}

// === GET (View earnings status) ===
export async function onRequestGet(context) {
  const { env } = context;
  const db = env.DB;
  let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };

  if (db) {
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      if (r) earnings = JSON.parse(r.data);
    } catch (e) {
      console.error("❌ Failed to read earnings for GET:", e.message);
    }
  }

  return new Response(JSON.stringify({
    message: "Withdraw API ready - LOCKED BANK",
    lockedBank: {
      bankName: env.YOUR_BANK_NAME || "Maybank",
      holder: env.YOUR_BANK_HOLDER || "Nicks Creations",
      accountMasked: env.YOUR_BANK_ACCOUNT ? "****" + env.YOUR_BANK_ACCOUNT.slice(-4) : "not set",
      locked: true
    },
    earnings: {
      total: earnings.total || 0,
      available: earnings.available || 0,
      withdrawn: earnings.withdrawn || 0,
      history: (earnings.history || []).slice(-10)
    },
    security: "Bank fixed in server code"
  }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });
}

// === DELETE (Reset earnings to 0) ===
export async function onRequestDelete(context) {
  const authError = verifyAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const { env } = context;
    const clientIP = context.request.headers.get('CF-Connecting-IP') || 'unknown';
    const db = env.DB;
    let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };

    if (db) {
      try {
        await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        if (r) earnings = JSON.parse(r.data);
      } catch (e) {
        console.error("❌ Failed to read earnings for DELETE reset:", e.message);
        return new Response(JSON.stringify({ 
          error: "Database error. Please try again." 
        }), { 
          status: 500, 
          headers: { "Content-Type": "application/json", ...cors() } 
        });
      }
    }

    const prevWithdrawn = earnings.withdrawn || 0;
    const prevAvailable = earnings.available || 0;
    const prevTotal = earnings.total || 0;
    
    earnings.withdrawn = 0;
    earnings.available = 0;
    earnings.total = 0;
    earnings.history = earnings.history || [];
    earnings.history.push({
      type: "reset",
      date: new Date().toISOString(),
      note: "FULL RESET - All to 0 via DELETE",
      prevWithdrawn,
      prevAvailable,
      prevTotal,
      ip: clientIP
    });

    if (db) {
      try {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_fee_earnings", JSON.stringify(earnings))
          .run();
        console.log(`✅ Withdrawal reset via DELETE (IP: ${clientIP})`);
      } catch (e) {
        console.error("❌ Failed to save DELETE reset:", e.message);
        return new Response(JSON.stringify({ 
          error: "Failed to reset. Please try again." 
        }), { 
          status: 500, 
          headers: { "Content-Type": "application/json", ...cors() } 
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: "Withdrawn reset to RM0.00",
      earnings,
      reset: true
    }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });

  } catch (err) {
    console.error("❌ DELETE reset failed:", err.message, err.stack);
    return new Response(JSON.stringify({ 
      error: "Reset failed. Please try again later." 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json", ...cors() } 
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}