// /api/withdraw.js - FIXED: Auth + Error Handling + RESET support

function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expectedToken = env.ADMIN_TOKEN || "secret";
  const expected = "Bearer " + expectedToken;
  
  console.log("🔐 Withdraw Auth Check:");
  console.log("  Received:", auth);
  console.log("  Expected:", expected);
  
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

// === POST (Withdraw + Reset) ===
export async function onRequestPost(context) {
  const authError = verifyAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const { request, env } = context;

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
        console.error("Failed to read fee earnings:", e.message);
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
      earnings.history = [];
      earnings.history.push({
        type: "reset",
        date: new Date().toISOString(),
        note: "FULL RESET - All to 0 by admin",
        prevWithdrawn,
        prevAvailable,
        prevTotal
      });

      if (db) {
        try {
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(earnings)).run();
        } catch (e) {
          console.error("Failed to save reset earnings:", e.message);
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

    if (!accountNumber) {
      return new Response(JSON.stringify({ error: "Bank account not set in env YOUR_BANK_ACCOUNT" }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
    }

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return new Response(JSON.stringify({ error: "Invalid amount" }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
    }

    if (Number(amount) > (earnings.available || 0)) {
      return new Response(JSON.stringify({ error: `Insufficient balance. Available: RM${(earnings.available || 0).toFixed(2)}` }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
    }

    const maskedAccount = accountNumber.slice(-4).padStart(accountNumber.length, "*");

    const withdrawal = {
      id: "WD_" + Date.now(),
      amount: Number(amount),
      bankName,
      bankCode,
      accountHolder,
      accountNumber: maskedAccount,
      fullAccountForPayout: "***LOCKED***",
      note: "Platform fee withdrawal - Locked to owner account",
      date: new Date().toISOString(),
      status: "Pending - Locked Bank",
      locked: true
    };

    if (db) {
      try {
        earnings.available = Math.max(0, (earnings.available || 0) - Number(amount));
        earnings.withdrawn = (earnings.withdrawn || 0) + Number(amount);
        earnings.history.push({ ...withdrawal, type: "withdrawal" });
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(earnings)).run();
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_locked_bank", JSON.stringify({
            bankName,
            bankCode,
            accountHolder,
            accountNumber: maskedAccount,
            lastUpdated: new Date().toISOString()
          }))
          .run();
      } catch (e) {
        console.error("Failed to save withdrawal:", e.message);
        return new Response(JSON.stringify({ error: "Database save failed: " + e.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Withdraw RM${Number(amount).toFixed(2)} locked to ${bankName} ${accountHolder}`,
      withdrawal,
      earnings,
      security: "Bank details LOCKED server-side"
    }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });

  } catch (err) {
    console.error("Withdraw request failed:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
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
      console.error("Failed to read earnings for GET:", e.message);
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
    earnings,
    security: "Bank fixed in server code"
  }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });
}

// === DELETE (Reset earnings to 0) ===
export async function onRequestDelete(context) {
  const authError = verifyAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const { env } = context;
    const db = env.DB;
    let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };

    if (db) {
      try {
        await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        if (r) earnings = JSON.parse(r.data);
      } catch (e) {
        console.error("Failed to read earnings for DELETE reset:", e.message);
      }
    }

    const prevWithdrawn = earnings.withdrawn || 0;
    const prevAvailable = earnings.available || 0;
    const prevTotal = earnings.total || 0;
    earnings.withdrawn = 0;
    earnings.available = 0;
    earnings.total = 0;
    earnings.history = [];
    earnings.history.push({
      type: "reset",
      date: new Date().toISOString(),
      note: "FULL RESET - All to 0 via DELETE",
      prevWithdrawn,
      prevAvailable,
      prevTotal
    });

    if (db) {
      try {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(earnings)).run();
      } catch (e) {
        console.error("Failed to save DELETE reset:", e.message);
        return new Response(JSON.stringify({ error: "Database save failed: " + e.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: "Withdrawn reset to RM0.00",
      earnings,
      reset: true
    }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });

  } catch (err) {
    console.error("DELETE reset failed:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}
