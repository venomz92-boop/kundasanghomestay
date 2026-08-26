// /api/withdraw.js - with D1 rate limiting
import { corsHeaders, getClientIP, logAction, enforceHttps, getAdminToken, checkRateLimit, recordRateLimit, parseJSONSafely } from './_utils.js';

async function verifyAdmin(request, env) {
  const auth = await getAdminToken(request);
  if (!env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers: corsHeaders(request) });
  if (auth !== env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders(request) });
  return null;
}

function validateAmount(amount) {
  const num = Number(amount);
  if (isNaN(num) || num <= 0) return false;
  const str = String(num);
  if (str.includes('.') && str.split('.')[1].length > 2) return false;
  return true;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Database not configured" }), { status: 500, headers: corsHeaders(request) });
    }

    // D1-based rate limiting
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const rateOk = await checkRateLimit(db, clientIP, 'withdraw', 3, 5 * 60);
    if (!rateOk) {
      return new Response(JSON.stringify({ 
        error: "Too many withdrawal attempts. Please wait 5 minutes." 
      }), { 
        status: 429, 
        headers: corsHeaders(request) 
      });
    }

    const LOCKED_BANK = {
      bankName: env.YOUR_BANK_NAME || "Maybank",
      bankCode: env.YOUR_BANK_CODE || "MBBEMYKL",
      accountHolder: env.YOUR_BANK_HOLDER || "Nicks Creations",
      accountNumber: env.YOUR_BANK_ACCOUNT || ""
    };

    const data = await parseJSONSafely(request);
    const { amount, reset, action } = data || {};

    let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };

    try {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      if (r) earnings = JSON.parse(r.data);
    } catch (e) {
      console.error("❌ Failed to read fee earnings:", e.message);
      return new Response(JSON.stringify({ 
        error: "Database error. Please try again later." 
      }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

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

      try {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_fee_earnings", JSON.stringify(earnings))
          .run();
        
        await logAction({
          db,
          action: 'withdrawal_reset',
          admin: 'admin',
          details: `Reset earnings to 0. Previous: Total RM${prevTotal}, Available RM${prevAvailable}, Withdrawn RM${prevWithdrawn}`,
          ip: clientIP
        });
      } catch (e) {
        console.error("❌ Failed to save reset earnings:", e.message);
        return new Response(JSON.stringify({ 
          error: "Failed to reset. Please try again." 
        }), { 
          status: 500, 
          headers: corsHeaders(request) 
        });
      }

      return new Response(JSON.stringify({
        success: true,
        message: "Withdrawn reset to RM0.00",
        earnings,
        reset: true
      }), { status: 200, headers: corsHeaders(request) });
    }

    const bankName = LOCKED_BANK.bankName;
    const accountHolder = LOCKED_BANK.accountHolder;
    const accountNumber = LOCKED_BANK.accountNumber;
    const bankCode = LOCKED_BANK.bankCode;

    if (!accountNumber) {
      console.error("❌ Bank account not configured");
      return new Response(JSON.stringify({ 
        error: "Bank account not configured. Please contact support." 
      }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    if (!amount) {
      return new Response(JSON.stringify({ 
        error: "Amount is required" 
      }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    if (!validateAmount(amount)) {
      return new Response(JSON.stringify({ 
        error: "Invalid amount. Please enter a valid number with up to 2 decimal places." 
      }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    const withdrawAmount = Number(amount);
    if (withdrawAmount > (earnings.available || 0)) {
      return new Response(JSON.stringify({ 
        error: `Insufficient balance. Available: RM${(earnings.available || 0).toFixed(2)}` 
      }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    if (withdrawAmount < 10) {
      return new Response(JSON.stringify({ 
        error: "Minimum withdrawal is RM10.00" 
      }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    // Record the attempt in D1
    await recordRateLimit(db, clientIP, 'withdraw');

    const maskedAccount = accountNumber.slice(-4).padStart(accountNumber.length, "*");

    const isProduction = env.ENVIRONMENT === "production";
    const isSimulation = !isProduction && env.PAYOUT_SIMULATION === "true";
    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";

    let payoutSuccess = false;
let payoutData = null;
let payoutError = null;

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
    const res = await fetch(endpoint, {
      method: "POST",
      body: formData,
      headers: { 'User-Agent': 'KundasangHomestay/1.0' }
    });
    const text = await res.text();
    console.log(`🔍 Payout response from ${endpoint}:`, text); // <-- ADD LOG
    try { payoutData = JSON.parse(text); } catch { payoutData = { raw: text }; }
    if (res.ok && (payoutData.status === "success" || payoutData[0]?.status === "success" || payoutData.payoutCode)) {
      payoutSuccess = true;
      break;
    }
    payoutError = payoutData;
  } catch (e) {
    payoutError = e.message;
    console.error(`❌ Payout endpoint ${endpoint} failed:`, e.message);
  }
}    
  
  
  } else if (isSimulation) {
      payoutSuccess = true;
      payoutData = { simulation: true };
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: "ToyyibPay payout is not enabled. Withdrawals are disabled in production until ToyyibPay payout is configured."
      }), { 
        status: 503, 
        headers: corsHeaders(request) 
      });
    }

    if (!payoutSuccess) {
      return new Response(JSON.stringify({
        success: false,
        error: "ToyyibPay payout to your bank failed. Please try again or check your ToyyibPay balance.",
        details: payoutError
      }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

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
      
      await logAction({
        db,
        action: 'withdrawal_completed',
        admin: 'admin',
        details: `Withdrawal RM${withdrawAmount} to ${bankName} (${accountHolder})`,
        ip: clientIP
      });
    } catch (e) {
      console.error("❌ Failed to save withdrawal after successful payout:", e.message);
      return new Response(JSON.stringify({ 
        error: "Payout succeeded, but failed to update records. Please check your ToyyibPay dashboard and contact support immediately.",
        payoutId: withdrawal.payoutId
      }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: `RM${withdrawAmount.toFixed(2)} sent to your bank account (${bankName} ${accountHolder}). 
                ${isToyyibLive ? 'ToyyibPay is processing the transfer.' : '(Simulation mode - no real money sent)'}`,
      withdrawal,
      earnings,
      security: "Bank details LOCKED server-side",
      simulation: payoutData?.simulation || false
    }), { status: 200, headers: corsHeaders(request) });

  } catch (err) {
    console.error("❌ Withdraw request failed:", err.message);
    return new Response(JSON.stringify({ 
      error: "Withdrawal failed. Please try again later." 
    }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

// GET and DELETE unchanged (they use D1 as well, but no rate limit needed for read/reset)
// We'll keep them as they were, but ensure they use D1.
// (The DELETE already uses D1, but we could add rate limiting if desired, not required.)
