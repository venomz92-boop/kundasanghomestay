// /api/owner-checkin.js - with checkinCode verification
import { corsHeaders, getClientIP, logAction, enforceHttps, getOwnerSession, jsonResponse } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const ownerData = await getOwnerSession(request, env);
    if (!ownerData || ownerData.type !== 'owner') {
      return jsonResponse({ error: 'Unauthorized: Invalid or expired token' }, 401, request);
    }

    const body = await request.json();
    const bookingId = body.bookingId;
    const checkinCode = body.checkinCode;   // <-- get from request

    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res && res.data) { try { bookings = JSON.parse(res.data); } catch(e) {} }
    const booking = bookings.find(b => String(b.id) === String(bookingId));

    if (!booking) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }

    // Authorization
    if (!(ownerData.homestayIds || [ownerData.ownerId]).map(String).includes(String(booking.homestayId))) {
      console.warn(`⚠️ Owner ${ownerData.whatsapp} tried to check-in booking for homestay ${booking.homestayId} but owns ${ownerData.ownerId}`);
      return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
    }

    // Already paid out?
    if (booking.payoutSuccessDate) {
      return jsonResponse({
        success: false,
        warning: true,
        message: `Booking ${bookingId} already paid out on ${booking.payoutSuccessDate}`
      }, 200, request);
    }

    // Payment verification
    if (!booking.status || !booking.status.toLowerCase().includes("paid")) {
      return jsonResponse({ error: 'Booking is not paid yet' }, 400, request);
    }

    // ===== CHECK-IN CODE VERIFICATION =====
    if (booking.checkinCode && booking.checkinCode !== checkinCode) {
      return jsonResponse({ error: 'Invalid check-in code. Please ask the guest for the 6-digit code sent to their WhatsApp/email.' }, 400, request);
    }
    // If no code (legacy bookings), skip verification (or you can reject)

    // Verify with ToyyibPay API if billcode exists
    if (booking.toyyibpay_billcode && env.TOYYIBPAY_SECRET_KEY) {
      try {
        const verifyUrl = `https://toyyibpay.com/index.php/api/getBill?billCode=${booking.toyyibpay_billcode}&userSecretKey=${env.TOYYIBPAY_SECRET_KEY}`;
        const verifyRes = await fetch(verifyUrl);
        const verifyData = await verifyRes.json();
        if (!verifyData || !verifyData[0] || verifyData[0].billpaymentStatus !== "1") {
          return jsonResponse({ 
            error: 'Payment not verified with ToyyibPay. Please contact support.' 
          }, 400, request);
        }
        booking.toyyibpay_last_check = new Date().toISOString();
        booking.toyyibpay_status = verifyData[0].billpaymentStatus;
      } catch (e) {
        console.error("Payment verification API error:", e.message);
        await logAction({
          db,
          action: 'payment_verification_failed',
          admin: 'owner',
          details: `Payment verification API failed for booking ${bookingId}: ${e.message}`,
          ip: getClientIP(request),
          userId: booking.guestEmail,
          homestayId: booking.homestayId
        });
      }
    }

    // Get homestay for bank details
    const rApproved = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    let homestays = [];
    if (rApproved && rApproved.data) { try { homestays = JSON.parse(rApproved.data); } catch(e) {} }
    const homestay = homestays.find(h => String(h.id) === String(booking.homestayId));
    if (!homestay) {
      return jsonResponse({ error: 'Homestay configuration missing (bank details)' }, 500, request);
    }

    const ownerAmount = booking.base || 0;
    const ownerAcc = homestay.ownerBankAccount || "";
    const ownerName = homestay.bankHolder || homestay.ownerName || "";
    const ownerBankCode = homestay.bankCode || "MBBEMYKL";

    if (!ownerAcc || ownerAmount <= 0) {
      return jsonResponse({ error: 'Missing owner bank account or invalid amount' }, 400, request);
    }

    // ---- Determine mode ----
    const isToyyibLive = !!env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
    const isSimulation = env.PAYOUT_SIMULATION === "true";

    let payoutSuccess = false;
    let payoutData = null;

    // ---- SIMULATION (if flag is true) ----
    if (isSimulation) {
      console.log(`🔵 SIMULATION: Payout for booking ${bookingId} (RM${ownerAmount}) to ${ownerName} (${ownerAcc})`);
      payoutSuccess = true;
      payoutData = { simulation: true, status: 'success', message: 'Simulated payout successful' };
    } else if (isToyyibLive) {
      // Real ToyyibPay payout API call
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
    } else {
      return jsonResponse({
        error: 'Owner payout is not enabled and simulation is off. Set PAYOUT_SIMULATION=true for testing.'
      }, 503, request);
    }

    // ---- Update booking status ----
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx !== -1) {
      if (payoutSuccess) {
        bookings[idx].status = "Completed - Payout Success";
        bookings[idx].payoutSuccess = true;
        bookings[idx].payoutSuccessDate = new Date().toISOString();
        bookings[idx].payoutAmount = Number(ownerAmount);
        bookings[idx].payoutMethod = isSimulation ? "Simulated Owner Check-in" : "ToyyibPay Auto Payout";
        bookings[idx].ownerPayoutId = payoutData?.payoutCode || payoutData?.id || "OWNER_" + Date.now();
        bookings[idx].completedDate = new Date().toISOString();
        bookings[idx].payoutAttempts = (bookings[idx].payoutAttempts || 0) + 1;
      } else {
        bookings[idx].status = "Paid - Awaiting Check-in";
        bookings[idx].payoutFailedAttempt = true;
        bookings[idx].lastPayoutError = payoutData;
      }
    }

    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_bookings", JSON.stringify(bookings))
      .run();

    if (!payoutSuccess) {
      return jsonResponse({
        error: 'ToyyibPay payout could not be confirmed. Booking remains paid and payout can be retried.'
      }, 502, request);
    }

    // ---- Record fee earnings ----
    try {
      const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
      let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
      
      const alreadyRecorded = feeEarnings.history?.some(h => h.bookingId === bookingId && h.type === "earning");
      if (!alreadyRecorded) {
        const finalFee = (booking.fee || 0) - (booking.gatewayFee || 0);
        const feeToRecord = finalFee > 0 ? finalFee : (booking.fee || 0);
        if (feeToRecord > 0) {
          feeEarnings.total = (feeEarnings.total || 0) + feeToRecord;
          feeEarnings.available = (feeEarnings.available || 0) + feeToRecord;
          feeEarnings.history = feeEarnings.history || [];
          feeEarnings.history.push({
            bookingId,
            fee: feeToRecord,
            date: new Date().toISOString(),
            type: "earning",
            payoutToOwner: Number(ownerAmount),
            ownerAcc: "****" + ownerAcc.slice(-4),
            method: isSimulation ? "simulation" : "toyyibpay_auto",
            ip: getClientIP(request)
          });
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_fee_earnings", JSON.stringify(feeEarnings))
            .run();
        }
      }
    } catch(e) {
      console.error("❌ Failed to record fee earnings:", e.message);
    }

    // Log
    await logAction({
      db,
      action: isSimulation ? 'owner_checkin_simulation' : 'owner_checkin_payout_success',
      admin: 'owner',
      details: `Check-in for ${bookingId}, payout ${isSimulation ? 'simulated' : 'completed via ToyyibPay'}`,
      ip: getClientIP(request),
      userId: booking.guestEmail,
      homestayId: booking.homestayId
    });

    return jsonResponse({
      success: true,
      message: `✅ Check-in confirmed! ${isSimulation ? '⚠️ SIMULATED payout of RM' : 'Payout of RM'}${ownerAmount} ${isSimulation ? 'completed (SIMULATION MODE – no real money sent)' : 'has been processed'}.`,
      bookingId,
      payout: payoutData,
      simulation: isSimulation,
      warning: isSimulation ? '⚠️ SIMULATION MODE – set PAYOUT_SIMULATION=false for live transfers' : undefined
    }, 200, request);

  } catch (e) {
    console.error("❌ Owner check-in error:", e.message, e.stack);
    return jsonResponse({ error: 'Check-in failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}