// /api/owner-checkin.js - SECURE Owner Check-In
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

    // Must be paid
    if (!booking.status || !booking.status.toLowerCase().includes("paid")) {
      return jsonResponse({ error: 'Booking is not paid yet' }, 400, request);
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

    // Attempt payout via ToyyibPay
    const isToyyibLive = !!env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
    const isSimulation = env.PAYOUT_SIMULATION === "true";
    let payoutSuccess = false;
    let payoutData = null;

    if (isSimulation) {
      payoutSuccess = true;
      payoutData = { simulation: true };
    } else if (isToyyibLive) {
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
        error: 'Owner payout is not enabled. Configure ToyyibPay payout or explicitly enable PAYOUT_SIMULATION for testing.'
      }, 503, request);
    }

    // Update booking status
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx !== -1) {
      if (payoutSuccess) {
        // Payout request succeeded, but we need to wait for webhook confirmation
        bookings[idx].status = "Payout Processing";
        bookings[idx].payoutRequested = true;
        bookings[idx].payoutRequestedDate = new Date().toISOString();
        bookings[idx].payoutAmount = Number(ownerAmount);
        bookings[idx].payoutMethod = "Owner Self Check-in";
        bookings[idx].ownerPayoutId = payoutData?.payoutCode || payoutData?.id || "OWNER_" + Date.now();
        bookings[idx].payoutAttempts = (bookings[idx].payoutAttempts || 0) + 1;
        // Do NOT set payoutSuccess or payoutSuccessDate yet
      } else {
        // Payout API failed – keep as Paid, allow retry
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

    // Log the check-in
    await logAction({
      db,
      action: 'owner_checkin_payout_requested',
      admin: 'owner',
      details: `Check-in for ${bookingId}, payout requested (pending webhook confirmation)`,
      ip: getClientIP(request),
      userId: booking.guestEmail,
      homestayId: booking.homestayId
    });

    return jsonResponse({
      success: true,
      message: `✅ Check-in confirmed! Payout of RM${ownerAmount} is being processed. You will receive confirmation once ToyyibPay completes the transfer.`,
      bookingId,
      payout: payoutData
    }, 200, request);

  } catch (e) {
    console.error("❌ Owner check-in error:", e.message, e.stack);
    return jsonResponse({ error: 'Check-in failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
