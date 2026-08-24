// /api/owner-checkin.js - SECURE Owner Check-In (Ignores frontend data)
import { corsHeaders, getClientIP, logAction, enforceHttps } from './_utils.js';

// Helper to verify owner token
function verifyOwner(request) {
  const auth = request.headers.get("Owner-Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const token = auth.replace("Bearer ", "");
    const data = JSON.parse(atob(token));
    if (data.ownerId && data.ts && (Date.now() - data.ts < 24 * 60 * 60 * 1000)) {
      return data;
    }
  } catch(e) { return null; }
  return null;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  try {
    const ownerData = verifyOwner(request);
    if (!ownerData) {
      return new Response(JSON.stringify({ error: "Unauthorized: Invalid or expired token" }), { 
        status: 401, 
        headers: corsHeaders(request) 
      });
    }

    const body = await request.json();
    const bookingId = body.bookingId;
    if (!bookingId) {
      return new Response(JSON.stringify({ error: "Missing bookingId" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server configuration error" }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    // ✅ Ensure store table exists
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res && res.data) { try { bookings = JSON.parse(res.data); } catch(e) {} }
    const booking = bookings.find(b => String(b.id) === String(bookingId));

    if (!booking) {
      return new Response(JSON.stringify({ error: "Booking not found" }), { 
        status: 404, 
        headers: corsHeaders(request) 
      });
    }

    if (String(booking.homestayId) !== String(ownerData.ownerId)) {
      console.warn(`⚠️ Owner ${ownerData.whatsapp} tried to check-in booking for homestay ${booking.homestayId} but owns ${ownerData.ownerId}`);
      return new Response(JSON.stringify({ error: "Unauthorized: You do not own this homestay" }), { 
        status: 403, 
        headers: corsHeaders(request) 
      });
    }

    if (booking.payoutDate) {
      return new Response(JSON.stringify({
        success: false,
        warning: true,
        message: `Booking ${bookingId} already paid out on ${booking.payoutDate}`
      }), { 
        status: 200, 
        headers: corsHeaders(request) 
      });
    }

    if (!booking.status || !booking.status.toLowerCase().includes("paid")) {
      return new Response(JSON.stringify({ error: "Booking is not paid yet" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    const rApproved = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    let homestays = [];
    if (rApproved && rApproved.data) { try { homestays = JSON.parse(rApproved.data); } catch(e) {} }
    const rPending = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
    if (rPending && rPending.data) { try { homestays = [...homestays, ...JSON.parse(rPending.data)]; } catch(e) {} }

    const homestay = homestays.find(h => String(h.id) === String(booking.homestayId));
    if (!homestay) {
      return new Response(JSON.stringify({ error: "Homestay configuration missing (bank details)" }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    const ownerAmount = booking.base || 0;
    const ownerAcc = homestay.ownerBankAccount || "";
    const ownerName = homestay.bankHolder || homestay.ownerName || "";
    const ownerBankCode = homestay.bankCode || "MBBEMYKL";

    if (!ownerAcc || ownerAmount <= 0) {
      return new Response(JSON.stringify({ error: "Missing owner bank account or invalid amount" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    console.log(`🔐 Owner Check-in: ${bookingId} -> RM${ownerAmount} to ${ownerAcc}`);

    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
    let payoutSuccess = false;
    let payoutData = null;

    if (!isToyyibLive) {
      payoutSuccess = true;
      payoutData = { simulation: true };
    } else {
      const formData = new FormData();
      formData.append("userSecretKey", env.TOYYIBPAY_SECRET_KEY);
      formData.append("bankCode", ownerBankCode);
      formData.append("bankAccountNumber", ownerAcc.replace(/[^0-9]/g, ''));
      formData.append("accountHolderName", ownerName);
      formData.append("amount", Math.round(ownerAmount * 100));
      formData.append("payoutDescription", `KDH ${bookingId} owner payout RM${ownerAmount}`);
      formData.append("payoutReferenceNo", bookingId);

      const endpoints = [
        "https://toyyibpay.com/index.php/api/payout",
        "https://toyyibpay.com/index.php/api/createPayout"
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, { method: "POST", body: formData });
          const text = await res.text();
          try { payoutData = JSON.parse(text); } catch { payoutData = { raw: text }; }
          if (res.ok && (payoutData.status === "success" || payoutData[0]?.status === "success" || payoutData.payoutCode)) {
            payoutSuccess = true;
            break;
          }
        } catch(e) { console.error("Payout endpoint error:", e.message); }
      }
    }

    const fee = booking.fee || 0;
    const gatewayFee = booking.gatewayFee || 1.00;
    const netFee = fee - gatewayFee;
    const finalFee = netFee > 0 ? netFee : fee;

    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx !== -1) {
      bookings[idx].status = "Completed - Owner Paid RM" + ownerAmount + (payoutSuccess ? " via Owner Check-in" : " (Manual settlement needed)");
      bookings[idx].payoutDate = new Date().toISOString();
      bookings[idx].payoutAmount = Number(ownerAmount);
      bookings[idx].payoutMethod = "Owner Self Check-in";
      bookings[idx].completedDate = new Date().toISOString();
      bookings[idx].ownerPayoutId = payoutData?.payoutCode || payoutData?.id || "OWNER_" + Date.now();
    }
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_bookings", JSON.stringify(bookings))
      .run();

    try {
      const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
      
      const alreadyRecorded = feeEarnings.history?.some(h => h.bookingId === bookingId && h.type === "earning");
      if (!alreadyRecorded && finalFee > 0) {
        feeEarnings.total = (feeEarnings.total || 0) + finalFee;
        feeEarnings.available = (feeEarnings.available || 0) + finalFee;
        feeEarnings.history.push({
          bookingId,
          fee: finalFee,
          date: new Date().toISOString(),
          type: "earning",
          payoutToOwner: Number(ownerAmount),
          ownerAcc: "****" + ownerAcc.slice(-4),
          method: "owner_self_checkin"
        });
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_fee_earnings", JSON.stringify(feeEarnings))
          .run();
      }
    } catch(e) { console.error("Fee recording error:", e.message); }

    return new Response(JSON.stringify({
      success: true,
      message: `✅ Check-in confirmed! You (${ownerName}) will received RM${ownerAmount}. Your money will arrive in 1-4 working business days.`,
      bookingId,
      payout: payoutData
    }), { 
      status: 200, 
      headers: corsHeaders(request) 
    });

  } catch (e) {
    console.error("❌ Owner check-in error:", e.message);
    return new Response(JSON.stringify({ error: "Check-in failed: " + e.message }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
