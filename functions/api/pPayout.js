export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { bookingId, homestayId, amount, fee, total, ownerBankCode, ownerAcc, ownerName } = body;

    if (!bookingId || !amount) {
      return new Response(JSON.stringify({ error: "Missing bookingId or amount" }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
    }

    const db = env.DB;
    const isPayoutLive = env.BILLPLZ_API_KEY && env.BILLPLZ_PAYOUT_ENABLED === "true";

    // Sanitize bank account (remove dashes/spaces)
    const cleanOwnerAcc = String(ownerAcc || "").replace(/[^0-9]/g, "");

    // --- SIMULATION MODE ---
    if (!isPayoutLive) {
      if (db) {
        await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1) {
          bookings[idx].status = "Completed - Owner Paid RM"+amount+" (Simulation)";
          bookings[idx].payoutDate = new Date().toISOString();
          bookings[idx].payoutAmount = Number(amount);
          bookings[idx].completedDate = new Date().toISOString();
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
        }
        // BUG FIX: also update fee earnings in simulation so withdraw works
        const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
        const netFee = Number(fee || 0) - 1.25;
        const finalFee = netFee > 0 ? netFee : Number(fee || 0);
        if (finalFee > 0) {
          feeEarnings.total = (feeEarnings.total || 0) + finalFee;
          feeEarnings.available = (feeEarnings.available || 0) + finalFee;
          feeEarnings.history.push({ bookingId, fee: finalFee, date: new Date().toISOString(), type: "earning", simulation: true });
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(feeEarnings)).run();
        }
      }
      return new Response(JSON.stringify({ 
        simulation: true, 
        success: true,
        message: `Simulation: Payout RM${amount} to owner would be sent on check-in. Enable BILLPLZ_PAYOUT_ENABLED for live transfer.`,
        bookingId,
        amount,
        ownerAccClean: cleanOwnerAcc ? "****"+cleanOwnerAcc.slice(-4) : ""
      }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    // LIVE Payout via Billplz Mass Payment
    const auth = btoa(env.BILLPLZ_API_KEY + ":");
    
    const payoutRes = await fetch("https://www.billplz.com/api/v3/mass_payment_instructions", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + auth,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        mass_payment_collection_id: env.BILLPLZ_MASS_COLLECTION_ID || env.BILLPLZ_COLLECTION_ID,
        bank_code: ownerBankCode || "MBBEMYKL",
        bank_account_number: cleanOwnerAcc,
        identity_number: "",
        name: ownerName || "Homestay Owner",
        description: `KDH ${bookingId} check-in payout RM${amount}`,
        total: Math.round(Number(amount) * 100),
        email: "owner@kundasanghomestay.com"
      })
    });

    const payoutData = await payoutRes.json();
    
    if (!payoutRes.ok) {
      return new Response(JSON.stringify({ 
        error: "Payout API failed", 
        details: payoutData,
        simulation: false,
        bookingId 
      }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
    }

    // Update D1
    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
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
      const finalFee = netFee > 0 ? netFee : Number(fee || 0);
      feeEarnings.total = (feeEarnings.total || 0) + finalFee;
      feeEarnings.available = (feeEarnings.available || 0) + finalFee;
      feeEarnings.history.push({ bookingId, fee: finalFee, date: new Date().toISOString(), type: "earning" });
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_fee_earnings", JSON.stringify(feeEarnings)).run();
    }

    return new Response(JSON.stringify({ 
      success: true,
      message: `Payout RM${amount} sent to owner ${ownerName}`,
      payout: payoutData,
      bookingId
    }), { headers: { "Content-Type": "application/json", ...cors() } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
  }
}

function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }

export async function onRequestOptions(){
  return new Response(null, { headers: cors() });
}
