// /api/withdraw - FIXED: env only inside functions + RESET support
// YOUR platform fee only - bank LOCKED server-side

export async function onRequestPost(context) {
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
      } catch(e){}
    }

    // === RESET HANDLER (sync with Reset to 0 button) ===
    if (reset === true || action === "reset") {
      const prevWithdrawn = earnings.withdrawn || 0;
      const prevAvailable = earnings.available || 0;
      const prevTotal = earnings.total || 0;
      // Reset ALL to 0 as requested
      earnings.withdrawn = 0;
      earnings.available = 0;
      earnings.total = 0;
      earnings.history = [];
      earnings.history.push({ type: "reset", date: new Date().toISOString(), note: "FULL RESET - All to 0 by admin", prevWithdrawn, prevAvailable, prevTotal });

      if (db) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(earnings)).run();
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
      return new Response(JSON.stringify({ error: `Insufficient balance. Available: RM${(earnings.available||0).toFixed(2)}` }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
    }

    const withdrawal = {
      id: "WD_" + Date.now(),
      amount: Number(amount),
      bankName: bankName,
      bankCode: bankCode,
      accountHolder: accountHolder,
      accountNumber: accountNumber.slice(-4).padStart(accountNumber.length, "*"),
      fullAccountForPayout: "***LOCKED***",
      note: "Platform fee withdrawal - Locked to owner account",
      date: new Date().toISOString(),
      status: "Pending - Locked Bank",
      locked: true
    };

    if (db) {
      earnings.available = Math.max(0, (earnings.available || 0) - Number(amount));
      earnings.withdrawn = (earnings.withdrawn || 0) + Number(amount);
      earnings.history.push({ ...withdrawal, type: "withdrawal" });
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(earnings)).run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_locked_bank", JSON.stringify({ bankName, bankCode, accountHolder, accountNumber: accountNumber.slice(-4).padStart(accountNumber.length, "*"), lastUpdated: new Date().toISOString() }))
        .run();
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Withdraw RM${Number(amount).toFixed(2)} locked to ${bankName} ${accountHolder}`,
      withdrawal,
      earnings,
      security: "Bank details LOCKED server-side"
    }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  const db = env.DB;
  let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };
  if (db) {
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      if (r) earnings = JSON.parse(r.data);
    } catch(e){}
  }
  return new Response(JSON.stringify({
    message: "Withdraw API ready - LOCKED BANK",
    lockedBank: { bankName: env.YOUR_BANK_NAME || "Maybank", holder: env.YOUR_BANK_HOLDER || "Nicks Creations", accountMasked: env.YOUR_BANK_ACCOUNT ? "****"+env.YOUR_BANK_ACCOUNT.slice(-4) : "not set", locked: true },
    earnings,
    security: "Bank fixed in server code"
  }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });
}

export async function onRequestDelete(context) {
  // Reset Withdrawn to 0 - called by Reset button
  try {
    const { env } = context;
    const db = env.DB;
    let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };
    if (db) {
      try {
        await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        if (r) earnings = JSON.parse(r.data);
      } catch(e){}
    }

    const prevWithdrawn = earnings.withdrawn || 0;
    const prevAvailable = earnings.available || 0;
    const prevTotal = earnings.total || 0;
    // Reset ALL to 0 as requested
    earnings.withdrawn = 0;
    earnings.available = 0;
    earnings.total = 0;
    earnings.history = [];
    earnings.history.push({ type: "reset", date: new Date().toISOString(), note: "FULL RESET - All to 0 via DELETE", prevWithdrawn, prevAvailable, prevTotal });

    if (db) {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(earnings)).run();
    }

    return new Response(JSON.stringify({
      success: true,
      message: "Withdrawn reset to RM0.00",
      earnings,
      reset: true
    }), { status: 200, headers: { "Content-Type": "application/json", ...cors() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
  }
}

function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: cors() }); }
