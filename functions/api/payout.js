// /api/payout.js - AUTO via ToyyibPay Payout
// Flow: Check-in -> ToyyibPay auto transfers Base to owner -> Fee stays with you
// Requires: TOYYIBPAY_SECRET_KEY + TOYYIBPAY_PAYOUT_ENABLED=true
// If payout not enabled, falls back to manual instruction

// === AUTH HELPER ===
function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_TOKEN || auth !== "Bearer " + env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...cors() }
    });
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  // Auth check
  const authError = verifyAdmin(request, env);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { bookingId, amount, fee, ownerBankCode, ownerAcc, ownerName } = body;

    if (!bookingId || !amount) {
      return new Response(JSON.stringify({ error: "Missing bookingId or amount" }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
    }

    const db = env.DB;
    const cleanOwnerAcc = String(ownerAcc || "").replace(/[^0-9]/g, "");
    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";

    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    }

    // --- MANUAL FALLBACK (if payout not enabled yet) ---
    if (!isToyyibLive) {
      if (db) {
        try {
          const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
          let bookings = res ? JSON.parse(res.data) : [];
          const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
          if (idx !== -1) {
            bookings[idx].status = "Completed - Owner Paid RM" + amount + " (Awaiting ToyyibPay Payout Activation)";
            bookings[idx].payoutDate = new Date().toISOString();
            bookings[idx].payoutAmount = Number(amount);
            bookings[idx].payoutMethod = "Manual until ToyyibPay Payout enabled";
            bookings[idx].completedDate = new Date().toISOString();
            await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
          }
        } catch (e) {
          console.error("Failed to update booking (manual fallback):", e.message);
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
    const formData = new FormData();
    formData.append("userSecretKey", env.TOYYIBPAY_SECRET_KEY);
    formData.append("bankCode", ownerBankCode || env.YOUR_BANK_CODE || "MBBEMYKL");
    formData.append("bankAccountNumber", cleanOwnerAcc);
    formData.append("accountHolderName", ownerName || "Homestay Owner");
    formData.append("amount", Math.round(Number(amount) * 100)); // in cents
    formData.append("payoutDescription", `KDH ${bookingId} owner payout RM${amount}`);
    formData.append("payoutReferenceNo", bookingId);

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
      } catch (e) {
        lastError = e.message;
        console.error(`Payout endpoint ${endpoint} failed:`, e.message);
      }
    }

    const isSuccess = payoutRes && payoutRes.ok;

    if (db) {
      try {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1) {
          bookings[idx].status = isSuccess
            ? "Completed - Owner Paid RM" + amount + " via ToyyibPay"
            : "Completed - Owner Paid RM" + amount + " (Payout API error, check settlement)";
          bookings[idx].payoutDate = new Date().toISOString();
          bookings[idx].payoutAmount = Number(amount);
          bookings[idx].payoutId = payoutData?.payoutCode || payoutData?.id || payoutData?.[0]?.PayoutCode || "TOYYIBPAY_" + Date.now();
          bookings[idx].payoutMethod = "ToyyibPay Auto Payout";
          bookings[idx].payoutResponse = payoutData;
          bookings[idx].completedDate = new Date().toISOString();
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
        }
      } catch (e) {
        console.error("Failed to update booking status after payout:", e.message);
      }

      // Fee earnings - you keep fee
      try {
        const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
        const netFee = Number(fee || 0) - 1.00;
        const finalFee = netFee > 0 ? netFee : Number(fee || 0);
        if (finalFee > 0) {
          feeEarnings.total = (feeEarnings.total || 0) + finalFee;
          feeEarnings.available = (feeEarnings.available || 0) + finalFee;
          feeEarnings.history.push({
            bookingId,
            fee: finalFee,
            date: new Date().toISOString(),
            type: "earning",
            payoutToOwner: Number(amount),
            ownerAcc: "****" + cleanOwnerAcc.slice(-4),
            method: "toyyibpay_auto"
          });
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(feeEarnings)).run();
        }
      } catch (e) {
        console.error("Failed to record fee earnings:", e.message);
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
    console.error("Payout request failed:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
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
    security: "Admin auth required for POST"
  }), { status: 200, headers: cors() });
}

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}
