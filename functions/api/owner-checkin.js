// /api/owner-checkin.js - with checkinCode verification and fallback for homestay data
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

    // ---- 1. Get bookings ----
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
    // If no code (legacy bookings), skip verification

    // ---- 2. Get homestay details from multiple stores (fallback chain) ----
    let homestay = null;
    let homestaySource = null;

    // Try kd_approved first
    const rApproved = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    let approved = [];
    if (rApproved && rApproved.data) { try { approved = JSON.parse(rApproved.data); } catch(e) {} }
    homestay = approved.find(h => String(h.id) === String(booking.homestayId));
    if (homestay) homestaySource = 'kd_approved';

    // If not found, try kd_homestays (synced by pending.js)
    if (!homestay) {
      const rHomestays = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_homestays").first();
      let homestays = [];
      if (rHomestays && rHomestays.data) { try { homestays = JSON.parse(rHomestays.data); } catch(e) {} }
      homestay = homestays.find(h => String(h.id) === String(booking.homestayId));
      if (homestay) homestaySource = 'kd_homestays';
    }

    // If still not found, try kd_pending (fallback)
    if (!homestay) {
      const rPending = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      let pending = [];
      if (rPending && rPending.data) { try { pending = JSON.parse(rPending.data); } catch(e) {} }
      homestay = pending.find(h => String(h.id) === String(booking.homestayId));
      if (homestay) homestaySource = 'kd_pending';
    }

    if (!homestay) {
      // We'll still allow check-in but skip payout
      console.warn(`⚠️ Homestay not found for booking ${bookingId} (homestayId: ${booking.homestayId}) in any store. Payout will be skipped.`);
      // Continue without payout, but mark booking as completed
    }

    const ownerAmount = booking.base || 0;
    const ownerAcc = homestay?.ownerBankAccount || "";
    const ownerName = homestay?.bankHolder || homestay?.ownerName || "";
    const ownerBankCode = homestay?.bankCode || "MBBEMYKL";

    // ---- 3. Determine payout mode ----
    const isToyyibLive = !!env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
    const isSimulation = env.PAYOUT_SIMULATION === "true";

    let payoutSuccess = false;
    let payoutData = null;
    let payoutMessage = '';

    // If homestay not found, skip payout
    if (!homestay) {
      payoutSuccess = false;
      payoutMessage = 'Check‑in confirmed, but payout skipped: Homestay details not found.';
    } else if (!ownerAcc || ownerAmount <= 0) {
      payoutMessage = 'Check‑in confirmed, but payout skipped: Missing bank account or invalid amount.';
    } else if (isSimulation) {
      // ---- SIMULATION ----
      console.log(`🔵 SIMULATION: Payout for booking ${bookingId} (RM${ownerAmount}) to ${ownerName} (${ownerAcc})`);
      payoutSuccess = true;
      payoutData = { simulation: true, status: 'success', message: 'Simulated payout successful' };
      payoutMessage = `Check‑in confirmed! ⚠️ SIMULATED payout of RM${ownerAmount} completed (no real money sent).`;
    } else if (isToyyibLive) {
      // ---- REAL TOYYIBPAY PAYOUT ----
      try {
        const formData = new FormData();
        formData.append("userSecretKey", env.TOYYIBPAY_SECRET_KEY);
        formData.append("bankCode", ownerBankCode);
        formData.append("bankAccountNumber", ownerAcc.replace(/[^0-9]/g, ''));
        formData.append("accountHolderName", ownerName);
        formData.append("amount", Math.round(ownerAmount * 100));
        formData.append("payoutDescription", `KDH ${bookingId} owner payout RM${ownerAmount}`);
        formData.append("payoutReferenceNo", bookingId);
        // ToyyibPay may have two endpoints; try both
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
              payoutMessage = `Check‑in confirmed! Payout of RM${ownerAmount} processed.`;
              break;
            }
          } catch(e) { console.error("Payout endpoint error:", e.message); }
        }
        if (!payoutSuccess) {
          payoutMessage = `Check‑in confirmed, but payout failed: ${payoutData?.error || 'Unknown error'}`;
        }
      } catch (e) {
        console.error("Payout request error:", e.message);
        payoutMessage = `Check‑in confirmed, but payout request encountered an error: ${e.message}`;
      }
    } else {
      payoutMessage = 'Check‑in confirmed, but payout is not enabled (set PAYOUT_SIMULATION=true for testing).';
    }

    // ---- 4. Update booking status ----
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
        bookings[idx].homestaySource = homestaySource; // for debugging
      } else {
        // Still mark as completed, but note payout not done
        bookings[idx].status = "Completed - Payout Pending";
        bookings[idx].checkedInAt = new Date().toISOString();
        bookings[idx].checkedInBy = 'owner';
        bookings[idx].payoutFailedAttempt = true;
        bookings[idx].lastPayoutError = payoutData || payoutMessage;
        bookings[idx].homestaySource = homestaySource;
      }
    }

    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_bookings", JSON.stringify(bookings))
      .run();

    // ---- 5. Log action ----
    await logAction({
      db,
      action: payoutSuccess ? 'owner_checkin_payout_success' : 'owner_checkin_payout_skipped',
      admin: 'owner',
      details: `Check-in for ${bookingId}, payout ${payoutSuccess ? 'success' : 'skipped/failed'}${homestaySource ? ' (source: '+homestaySource+')' : ''}`,
      ip: getClientIP(request),
      userId: booking.guestEmail,
      homestayId: booking.homestayId
    });

    // ---- 6. Record fee earnings (if success) ----
    if (payoutSuccess) {
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
    }

    return jsonResponse({
      success: true,
      message: payoutMessage || "Check‑in confirmed.",
      bookingId,
      payout: payoutData,
      payoutSuccess,
      simulation: isSimulation,
      homestaySource,
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
