// functions/api/withdraw.js - Cloudflare Pages Function
// Handles withdraw requests for platform fees
// Save to your repo as: functions/api/withdraw.js

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const data = await request.json();

    const { amount, bankName, accountHolder, accountNumber, note } = data;

    // Basic validation
    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({ error: "Invalid amount" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (!bankName || !accountHolder || !accountNumber) {
      return new Response(JSON.stringify({ error: "Missing bank details" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    // TODO: Replace with your real payout logic
    // Example: Call Billplz Payout API, or store in D1/KV
    // For now, we just log and return success (simulation mode)

    const withdrawal = {
      id: "WD_" + Date.now(),
      amount: Number(amount),
      bankName,
      accountHolder,
      accountNumber: accountNumber.slice(-4).padStart(accountNumber.length, "*"), // mask
      note: note || "",
      date: new Date().toISOString(),
      status: "Pending",
    };

    // If you have D1 binding: await env.DB.prepare("INSERT INTO withdrawals ...").run()
    // If you have KV binding: await env.WITHDRAWALS_KV.put(withdrawal.id, JSON.stringify(withdrawal))

    // Simulate success
    return new Response(
      JSON.stringify({
        success: true,
        message: `Withdraw request RM${Number(amount).toFixed(2)} submitted`,
        withdrawal,
        nextStep: "Funds will arrive in 1-2 business days. Check your bank.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

export async function onRequestGet(context) {
  // Return withdrawal history (from KV/D1 in real implementation)
  return new Response(
    JSON.stringify({
      message: "Withdraw API ready",
      usage: "POST /api/withdraw with { amount, bankName, accountHolder, accountNumber, note }",
      mode: "simulation - connect Billplz Payout API for live transfers",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
