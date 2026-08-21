// /api/payout.js - UPDATED FOR TOYYIBPAY + MANUAL DUITNOW
// Flow: After CHECK IN success, base RM goes to owner bank, fee stays with you
// Platform does NOT hold owner money after check-in - immediate transfer

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { bookingId, homestayId, amount, fee, total, ownerBankCode, ownerAcc, ownerName } = body;

    if (!bookingId || !amount) {
      return new Response(JSON.stringify({ error: "Missing bookingId or amount" }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
    }

    const db = env.DB;
    const cleanOwnerAcc = String(ownerAcc||"").replace(/[^0-9]/g, "");

    // Check if live payout enabled
    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
    const isBillplzLive = env.BILLPLZ_API_KEY && env.BILLPLZ_PAYOUT_ENABLED === "true";

    // Always update booking status first
    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    }

    // --- SIMULATION / MANUAL TRANSFER MODE (FASTEST FOR SABAH) ---
    // Use this if you don't have mass payout yet - you transfer manually via Maybank2u DuitNow, then click CHECK IN
    if (!isToyyibLive && !isBillplzLive) {
      if (db) {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1) {
          bookings[idx].status = "Completed - Owner Paid RM"+amount+" (Manual Transfer)";
          bookings[idx].payoutDate = new Date().toISOString();
          bookings[idx].payoutAmount = Number(amount);
          bookings[idx].payoutMethod = "Manual DuitNow - Owner gets base, you keep fee";
          bookings[idx].completedDate = new Date().toISOString();
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
        }
        // Update fee earnings - you keep fee
        const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
        const netFee = Number(fee||0) - 1.25;
        const finalFee = netFee > 0 ? netFee : Number(fee||0);
        if (finalFee > 0) {
          feeEarnings.total = (feeEarnings.total||0) + finalFee;
          feeEarnings.available = (feeEarnings.available||0) + finalFee;
          feeEarnings.history.push({ bookingId, fee: finalFee, date: new Date().toISOString(), type: "earning", payoutToOwner: Number(amount), ownerAcc: "****"+cleanOwnerAcc.slice(-4), method: "manual" });
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(feeEarnings)).run();
        }
      }
      return new Response(JSON.stringify({
        simulation: true,
        success: true,
        message: `Manual: Transfer RM${amount} to owner ${ownerName} (${cleanOwnerAcc}) via DuitNow. Fee RM${fee} stays with you. Enable TOYYIBPAY_PAYOUT_ENABLED or BILLPLZ_PAYOUT_ENABLED for auto transfer.`,
        bookingId,
        amount,
        owner: ownerName,
        ownerAccMasked: "****"+cleanOwnerAcc.slice(-4),
        instruction: `After CHECK IN, manually transfer RM${amount} to ${ownerName} - ${cleanOwnerAcc}. Your fee RM${fee} is now available for withdraw.`
      }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    // --- LIVE BILLPLZ MASS PAYOUT (if you get Billplz approved later) ---
    if (isBillplzLive) {
      const auth = btoa(env.BILLPLZ_API_KEY + ":");
      const payoutRes = await fetch("https://www.billplz.com/api/v3/mass_payment_instructions", {
        method: "POST",
        headers: { "Authorization": "Basic " + auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          mass_payment_collection_id: env.BILLPLZ_MASS_COLLECTION_ID || env.BILLPLZ_COLLECTION_ID,
          bank_code: ownerBankCode || "MBBEMYKL",
          bank_account_number: cleanOwnerAcc,
          name: ownerName || "Homestay Owner",
          description: `KDH ${bookingId} check-in payout RM${amount}`,
          total: Math.round(Number(amount) * 100),
          email: "owner@kundasanghomestay.com"
        })
      });
      const payoutData = await payoutRes.json();
      if (!payoutRes.ok) {
        return new Response(JSON.stringify({ error: "Billplz payout failed", details: payoutData }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
      }
      // Update D1
      if (db) {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1) {
          bookings[idx].status = "Completed - Owner Paid RM"+amount;
          bookings[idx].payoutDate = new Date().toISOString();
          bookings[idx].payoutAmount = Number(amount);
          bookings[idx].payoutId = payoutData.id;
          bookings[idx].completedDate = new Date().toISOString();
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
        }
        const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
        const netFee = Number(fee) - 1.25;
        const finalFee = netFee > 0 ? netFee : Number(fee||0);
        feeEarnings.total = (feeEarnings.total||0) + finalFee;
        feeEarnings.available = (feeEarnings.available||0) + finalFee;
        feeEarnings.history.push({ bookingId, fee: finalFee, date: new Date().toISOString(), type: "earning", payoutId: payoutData.id });
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(feeEarnings)).run();
      }
      return new Response(JSON.stringify({ success: true, message: `Auto payout RM${amount} to ${ownerName} via Billplz`, payout: payoutData, bookingId }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    // --- LIVE TOYYIBPAY PAYOUT (if enabled) ---
    // ToyyibPay payout API - similar flow
    // For now fallback to manual with success flag
    return new Response(JSON.stringify({
      success: true,
      simulation: true,
      message: `ToyyibPay payout ready - transfer RM${amount} to ${ownerName}`,
      bookingId
    }), { headers: { "Content-Type": "application/json", ...cors() } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
  }
}

function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: cors() }); }
