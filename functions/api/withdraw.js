// /api/withdraw - YOUR platform fee only (11% after RM1.25) - LOCKED BANK FOR SECURITY
// Owner payouts are via /api/payout on check-in confirm, NOT here
// SECURITY: Bank details are LOCKED server-side, frontend cannot change even if admin.html hacked

// 🔒 FIXED BANK - Change only here or via Cloudflare Secrets
const LOCKED_BANK = {
  bankName: "Maybank",
  bankCode: "MBBEMYKL",
  accountHolder: "Nicks Creations",
  accountNumber: "560269009305"
};

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const data = await request.json();
    const { amount } = data;
    // SECURITY: Ignore any bank details from frontend - use locked server values only
    const bankName = env.YOUR_BANK_NAME || LOCKED_BANK.bankName;
    const accountHolder = env.YOUR_BANK_HOLDER || LOCKED_BANK.accountHolder;
    const accountNumber = env.YOUR_BANK_ACCOUNT || LOCKED_BANK.accountNumber;
    const bankCode = env.YOUR_BANK_CODE || LOCKED_BANK.bankCode;

    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({ error: "Invalid amount" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const db = env.DB;
    let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };
    if (db) {
      try {
        await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        if (r) earnings = JSON.parse(r.data);
      } catch(e){}
    }

    const withdrawal = {
      id: "WD_" + Date.now(),
      amount: Number(amount),
      bankName: bankName,
      bankCode: bankCode,
      accountHolder: accountHolder,
      accountNumber: accountNumber.slice(-4).padStart(accountNumber.length, "*"),
      fullAccountForPayout: "***LOCKED***", // never expose full number in response
      note: "Platform fee withdrawal - Locked to owner account",
      date: new Date().toISOString(),
      status: "Pending - Locked Bank",
      locked: true
    };

    if (earnings.available > 0 && amount > earnings.available) {
      return new Response(JSON.stringify({ error: `Insufficient balance. Available: RM${earnings.available.toFixed(2)}` }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    if (db) {
      earnings.available = Math.max(0, (earnings.available || 0) - Number(amount));
      earnings.withdrawn = (earnings.withdrawn || 0) + Number(amount);
      earnings.history.push({ ...withdrawal, type: "withdrawal" });
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(earnings)).run();
      // Also store locked bank profile for audit
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_locked_bank", JSON.stringify({ bankName, bankCode, accountHolder, accountNumber: accountNumber.slice(-4).padStart(accountNumber.length, "*"), lastUpdated: new Date().toISOString() }))
        .run();
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Withdraw RM${Number(amount).toFixed(2)} locked to ${bankName} ${accountHolder} - Even if admin.html hacked, money goes to locked account`,
      withdrawal,
      earnings,
      security: "Bank details LOCKED server-side in /api/withdraw.js + env YOUR_BANK_* - frontend inputs ignored",
      note: "Owner payouts are separate via /api/payout on Confirm Check-In"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };
  if (db) {
    try {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      if (r) earnings = JSON.parse(r.data);
    } catch(e){}
  }
  return new Response(JSON.stringify({
    message: "Withdraw API ready - LOCKED BANK",
    lockedBank: { bankName: LOCKED_BANK.bankName, holder: LOCKED_BANK.accountHolder, accountMasked: "****9305", locked: true },
    earnings,
    security: "Bank fixed in server code - frontend cannot change"
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
