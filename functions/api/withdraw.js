// /api/withdraw - YOUR platform fee only (11% after RM1.25)
// Owner payouts are via /api/payout on check-in confirm, NOT here

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const data = await request.json();
    const { amount, bankName, accountHolder, accountNumber, note } = data;

    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({ error: "Invalid amount" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (!bankName || !accountHolder || !accountNumber) {
      return new Response(JSON.stringify({ error: "Missing bank details" }), { status: 400, headers: { "Content-Type": "application/json" } });
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
      bankName,
      accountHolder,
      accountNumber: accountNumber.slice(-4).padStart(accountNumber.length, "*"),
      note: note || "Platform fee withdrawal - Your earnings",
      date: new Date().toISOString(),
      status: "Pending - Your fee",
    };

    // Update earnings if we have it, otherwise allow (simulation)
    if (earnings.available > 0 && amount > earnings.available) {
      return new Response(JSON.stringify({ error: `Insufficient balance. Available: RM${earnings.available.toFixed(2)}` }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    if (db) {
      earnings.available = Math.max(0, (earnings.available || 0) - Number(amount));
      earnings.withdrawn = (earnings.withdrawn || 0) + Number(amount);
      earnings.history.push({ ...withdrawal, type: "withdrawal" });
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(earnings)).run();
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Withdraw request RM${Number(amount).toFixed(2)} submitted - Your fee earnings only`,
      withdrawal,
      earnings,
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
    message: "Withdraw API ready - Your fee only. Owner payouts via /api/payout",
    earnings,
    usage: "POST /api/withdraw with { amount, bankName, accountHolder, accountNumber }"
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
