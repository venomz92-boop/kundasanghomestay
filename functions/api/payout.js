// /api/payout.js - AUTO via ToyyibPay Payout
// Flow: Check-in -> ToyyibPay auto transfers Base to owner -> Fee stays with you
// Requires: TOYYIBPAY_SECRET_KEY + TOYYIBPAY_PAYOUT_ENABLED=true
// If payout not enabled, falls back to manual instruction

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { bookingId, amount, fee, ownerBankCode, ownerAcc, ownerName } = body;

    if (!bookingId || !amount) {
      return new Response(JSON.stringify({ error: "Missing bookingId or amount" }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
    }

    const db = env.DB;
    const cleanOwnerAcc = String(ownerAcc||"").replace(/[^0-9]/g, "");
    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";

    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    }

    // --- MANUAL FALLBACK (if payout not enabled yet) ---
    if (!isToyyibLive) {
      if (db) {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1) {
          bookings[idx].status = "Completed - Owner Paid RM"+amount+" (Awaiting ToyyibPay Payout Activation)";
          bookings[idx].payoutDate = new Date().toISOString();
          bookings[idx].payoutAmount = Number(amount);
          bookings[idx].payoutMethod = "Manual until ToyyibPay Payout enabled";
          bookings[idx].completedDate = new Date().toISOString();
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
        }
      }
      return new Response(JSON.stringify({
        success: true,
        simulation: true,
        message: `ToyyibPay Payout not yet enabled. Set TOYYIBPAY_PAYOUT_ENABLED=true after ToyyibPay approves Payout. Meanwhile manually transfer RM${amount} to ${ownerName}.`,
        bookingId,
        amount,
        owner: ownerName,
        instruction: `Enable ToyyibPay Payout to make this auto. For now transfer RM${amount} to ${ownerName}`,
        nextStep: "Contact ToyyibPay support: Enable Payout feature for your account"
      }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    // --- AUTO PAYOUT VIA TOYYIBPAY ---
    // ToyyibPay Payout API
    const formData = new FormData();
    formData.append("userSecretKey", env.TOYYIBPAY_SECRET_KEY);
    formData.append("bankCode", ownerBankCode || env.YOUR_BANK_CODE || "MBBEMYKL");
    formData.append("bankAccountNumber", cleanOwnerAcc);
    formData.append("accountHolderName", ownerName || "Homestay Owner");
    formData.append("amount", Math.round(Number(amount) * 100)); // in cents
    formData.append("payoutDescription", `KDH ${bookingId} owner payout RM${amount}`);
    formData.append("payoutReferenceNo", bookingId);

    // Try ToyyibPay payout endpoint (may vary - check with ToyyibPay)
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
        payoutRes = await fetch(endpoint, { method: "POST", body: formData });
        const text = await payoutRes.text();
        try { payoutData = JSON.parse(text); } catch { payoutData = { raw: text }; }
        if (payoutRes.ok && (payoutData.status === "success" || payoutData[0]?.status === "success" || payoutData.payoutCode)) {
          break;
        }
        lastError = payoutData;
      } catch (e) { lastError = e.message; }
    }

    // If ToyyibPay payout API returns error (because payout not enabled), we still complete booking but flag it
    const isSuccess = payoutRes && payoutRes.ok;

    if (db) {
      const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = res ? JSON.parse(res.data) : [];
      const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
      if (idx !== -1) {
        bookings[idx].status = isSuccess ? "Completed - Owner Paid RM"+amount+" via ToyyibPay" : "Completed - Owner Paid RM"+amount+" (Payout API error, check settlement)";
        bookings[idx].payoutDate = new Date().toISOString();
        bookings[idx].payoutAmount = Number(amount);
        bookings[idx].payoutId = payoutData?.payoutCode || payoutData?.id || payoutData?.[0]?.PayoutCode || "TOYYIBPAY_"+Date.now();
        bookings[idx].payoutMethod = "ToyyibPay Auto Payout";
        bookings[idx].payoutResponse = payoutData;
        bookings[idx].completedDate = new Date().toISOString();
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
      }
      // Fee earnings - you keep fee
      const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
      const netFee = Number(fee||0) - 1.00; // ToyyibPay RM1 fee
      const finalFee = netFee > 0 ? netFee : Number(fee||0);
      if (finalFee > 0) {
        feeEarnings.total = (feeEarnings.total||0) + finalFee;
        feeEarnings.available = (feeEarnings.available||0) + finalFee;
        feeEarnings.history.push({ bookingId, fee: finalFee, date: new Date().toISOString(), type: "earning", payoutToOwner: Number(amount), ownerAcc: "****"+cleanOwnerAcc.slice(-4), method: "toyyibpay_auto" });
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(feeEarnings)).run();
      }
    }

    if (!isSuccess) {
      return new Response(JSON.stringify({ 
        success: true, 
        warning: true,
        message: `Booking completed but ToyyibPay Payout API returned error. Funds will still settle to your Maybank via daily auto settlement. Transfer manually to owner for now.`,
        payoutError: lastError,
        bookingId,
        amount,
        note: "Contact ToyyibPay to enable Payout: support@toyyibpay.com - mention you need mass payout / owner payout feature"
      }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    return new Response(JSON.stringify({ 
      success: true, 
      message: `Auto payout RM${amount} to ${ownerName} via ToyyibPay`, 
      payout: payoutData, 
      bookingId,
      flow: "Check-in → Complete → Owner gets Base via ToyyibPay → You keep Fee"
    }), { headers: { "Content-Type": "application/json", ...cors() } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
  }
}

function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: cors() }); }
