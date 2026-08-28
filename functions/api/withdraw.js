// /api/withdraw.js - with admin auth for GET and fixed simulation logic
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
    let bookings = [];

    try {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      if (r) earnings = JSON.parse(r.data);
      const bRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      if (bRes) bookings = JSON.parse(bRes.data);
    } catch (e) {
      console.error("❌ Failed to read data:", e.message);
      return new Response(JSON.stringify({ 
        error: "Database error. Please try again later." 
      }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    // Fallback: compute total from bookings if stored total is 0
    if (earnings.total === 0 && bookings.length > 0) {
      const totalFees = bookings.reduce((sum, b) => {
        const status = (b.status || '').toLowerCase();
        if (status.includes('completed') || status.includes('payout') || status.includes('paid - awaiting check-in') || b.payoutDate) {
          return sum + (b.youReceive || b.fee || 0);
        }
        return sum;
      }, 0);
      if (totalFees > 0) {
        earnings.total = totalFees;
        earnings.available = totalFees - (earnings.withdrawn || 0);
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_fee_earnings", JSON.stringify(earnings))
          .run();
      }
    }

    const actualAvailable = (earnings.total || 0) - (earnings.withdrawn || 0);

    // Reset logic
    if (reset === true || action === "reset") {
      const prevWithdrawn = earnings.withdrawn || 0;
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
          details: `Reset earnings to 0. Previous: Total RM${prevTotal}, Withdrawn RM${prevWithdrawn}`,
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
        message: "Earnings reset to RM0.00",
        earnings: { ...earnings, available: 0 }
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
    if (withdrawAmount > actualAvailable) {
      return new Response(JSON.stringify({ 
        error: `Insufficient balance. Available: RM${actualAvailable.toFixed(2)}` 
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

    await recordRateLimit(db, clientIP, 'withdraw');

    const maskedAccount = accountNumber.slice(-4).padStart(accountNumber.length, "*");

    // ----- Correct simulation and live logic -----
    const isSimulation = env.PAYOUT_SIMULATION === "true";
    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";

    let payoutSuccess = false;
    let payoutData = null;
    let payoutError = null;

    if (isSimulation) {
      // ✅ SIMULATION – skip ToyyibPay
      payoutSuccess = true;
      payoutData = { simulation: true };
      console.log("🔵 SIMULATION: Withdrawal of RM" + withdrawAmount + " to " + accountHolder);
    } else if (isToyyibLive) {
      // Real ToyyibPay payout
      const formData = new FormData();
      formData.append("userSecretKey", env.TOYYIBPAY_SECRET_KEY);
      formData.append("bankCode", bankCode);
      formData.append("bankAccountNumber", accountNumber.replace(/[^0-9]/g, ''));
      formData.append("accountHolderName", accountHolder);
      formData.append("amount", Math.round(withdrawAmount * 100));
      formData.append("payoutDescription", `Platform Withdrawal WD_${Date.now()}`);
      formData.append("payoutReferenceNo", `WD_${Date.now()}`);

      const endpoints = [
        "https://dev.toyyibpay.com/index.php/api/payout",
        "https://dev.toyyibpay.com/index.php/api/createPayout"
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            body: formData,
            headers: { 'User-Agent': 'KundasangHomestay/1.0' }
          });
          const text = await res.text();
          console.log(`🔍 Payout response from ${endpoint}:`, text);
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
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: "ToyyibPay payout is not enabled and simulation is off. Set PAYOUT_SIMULATION=true or configure ToyyibPay."
      }), { 
        status: 503, 
        headers: corsHeaders(request) 
      });
    }

    if (!payoutSuccess) {
      const errorMsg = payoutError?.message || payoutError?.raw || payoutError || "Unknown error";
      console.error("❌ Payout failed with details:", errorMsg);
      return new Response(JSON.stringify({
        success: false,
        error: `ToyyibPay payout to your bank failed. Please try again or check your ToyyibPay balance.`,
        details: errorMsg
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
      date: new Date().toISOString(),
      status: "Success - Sent to your bank via ToyyibPay",
      ip: clientIP,
      payoutId: payoutData?.payoutCode || payoutData?.id || "AUTO_WD_" + Date.now(),
      simulation: payoutData?.simulation || false
    };

    try {
      earnings.withdrawn = (earnings.withdrawn || 0) + withdrawAmount;
      earnings.history.push({ ...withdrawal, type: "withdrawal" });
      earnings.available = earnings.total - earnings.withdrawn;

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
        error: "Payout succeeded, but failed to update records. Please check your ToyyibPay dashboard.",
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
      earnings: {
        total: earnings.total,
        withdrawn: earnings.withdrawn,
        available: earnings.total - earnings.withdrawn
      },
      security: "Bank details LOCKED server-side",
      simulation: payoutData?.simulation || false
    }), { status: 200, headers: corsHeaders(request) });

  } catch (err) {
    console.error("❌ Withdraw request failed:", err.message, err.stack);
    return new Response(JSON.stringify({ 
      error: "Withdrawal failed. Please try again later." 
    }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

// ===== GET =====
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  // 🔒 Require admin
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const db = env.DB;
  let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };

  if (db) {
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      if (r) earnings = JSON.parse(r.data);
      if (earnings.total === 0) {
        const bRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        if (bRes) {
          const bookings = JSON.parse(bRes.data);
          const totalFees = bookings.reduce((sum, b) => {
            const status = (b.status || '').toLowerCase();
            if (status.includes('completed') || status.includes('payout') || status.includes('paid - awaiting check-in') || b.payoutDate) {
              return sum + (b.youReceive || b.fee || 0);
            }
            return sum;
          }, 0);
          earnings.total = totalFees;
          earnings.available = totalFees - (earnings.withdrawn || 0);
        }
      } else {
        earnings.available = (earnings.total || 0) - (earnings.withdrawn || 0);
      }
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
  }), { status: 200, headers: corsHeaders(request) });
}

// ===== DELETE =====
export async function onRequestDelete({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  try {
    const clientIP = getClientIP(request);
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
          headers: corsHeaders(request) 
        });
      }
    }

    const prevWithdrawn = earnings.withdrawn || 0;
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
      prevTotal,
      ip: clientIP
    });

    if (db) {
      try {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_fee_earnings", JSON.stringify(earnings))
          .run();
        
        await logAction({
          db,
          action: 'withdrawal_reset_delete',
          admin: 'admin',
          details: `Reset earnings via DELETE. Previous: Total RM${prevTotal}, Withdrawn RM${prevWithdrawn}`,
          ip: clientIP
        });
      } catch (e) {
        console.error("❌ Failed to save DELETE reset:", e.message);
        return new Response(JSON.stringify({ 
          error: "Failed to reset. Please try again." 
        }), { 
          status: 500, 
          headers: corsHeaders(request) 
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: "Earnings reset to RM0.00",
      earnings: { ...earnings, available: 0 }
    }), { status: 200, headers: corsHeaders(request) });

  } catch (err) {
    console.error("❌ DELETE reset failed:", err.message);
    return new Response(JSON.stringify({ 
      error: "Reset failed. Please try again later." 
    }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

// ===== OPTIONS =====
export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
