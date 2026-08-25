// /api/owner-update-booking.js - Owner can change dates, confirm check-in, and cancel
import { corsHeaders, getClientIP, logAction, enforceHttps } from './_utils.js';

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

function calculateNights(checkin, checkout) {
  if (!checkin || !checkout) return 1;
  const d1 = new Date(checkin);
  const d2 = new Date(checkout);
  const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : 1;
}

function calculatePrice(ownerPrice, nights = 1) {
  const base = ownerPrice * nights;
  const fee = Math.round((base * 11) / 100);
  const gatewayFee = 1.00;
  const total = base + fee + gatewayFee;
  return { nights, base, fee, gatewayFee, total, youReceive: fee - gatewayFee };
}

function getDatesInRange(checkin, checkout) {
  if (!checkin || !checkout) return [];
  const dates = [];
  const start = new Date(checkin + 'T00:00:00');
  const end = new Date(checkout + 'T00:00:00');
  if (isNaN(start) || isNaN(end) || start >= end) return [];
  const cur = new Date(start);
  while (cur < end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const clientIP = getClientIP(request);

  try {
    const ownerData = verifyOwner(request);
    if (!ownerData) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders(request) });
    }

    const body = await request.json();
    const { bookingId, checkin, checkout, action } = body;

    if (!bookingId) {
      return new Response(JSON.stringify({ error: "Missing bookingId" }), { status: 400, headers: corsHeaders(request) });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server error" }), { status: 500, headers: corsHeaders(request) });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res && res.data) { try { bookings = JSON.parse(res.data); } catch(e) {} }

    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx === -1) {
      return new Response(JSON.stringify({ error: "Booking not found" }), { status: 404, headers: corsHeaders(request) });
    }

    const booking = bookings[idx];

    // SECURITY: Verify this owner owns this homestay
    if (String(booking.homestayId) !== String(ownerData.ownerId)) {
      console.warn(`⚠️ Owner ${ownerData.whatsapp} tried to modify booking for homestay ${booking.homestayId} but owns ${ownerData.ownerId}`);
      return new Response(JSON.stringify({ error: "Unauthorized: You do not own this homestay" }), { status: 403, headers: corsHeaders(request) });
    }

    // ========== ACTION: CHANGE DATES ==========
    if (action === "changeDates") {
      if (!checkin || !checkout) {
        return new Response(JSON.stringify({ error: "Missing checkin or checkout" }), { status: 400, headers: corsHeaders(request) });
      }

      const d1 = new Date(checkin);
      const d2 = new Date(checkout);
      if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
        return new Response(JSON.stringify({ error: "Invalid dates" }), { status: 400, headers: corsHeaders(request) });
      }

      // Get homestay to recalculate price
      const rApproved = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let homestays = [];
      if (rApproved && rApproved.data) { try { homestays = JSON.parse(rApproved.data); } catch(e) {} }
      const rPending = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if (rPending && rPending.data) { try { homestays = [...homestays, ...JSON.parse(rPending.data)]; } catch(e) {} }

      const homestay = homestays.find(h => String(h.id) === String(booking.homestayId));
      if (!homestay) {
        return new Response(JSON.stringify({ error: "Homestay not found" }), { status: 404, headers: corsHeaders(request) });
      }

      // Check availability (excluding this booking's own dates)
      const oldDates = getDatesInRange(booking.checkin, booking.checkout);
      
      // Get availability from DB
      const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
      let availabilityMap = {};
      if (availRes && availRes.data) { try { availabilityMap = JSON.parse(availRes.data); } catch(e) {} }
      
      const allBlocked = [];
      if (homestay.blockedDates) allBlocked.push(...homestay.blockedDates);
      if (availabilityMap[homestay.id]) allBlocked.push(...availabilityMap[homestay.id]);
      
      const blockedWithoutThis = allBlocked.filter(d => !oldDates.includes(d));
      const newDates = getDatesInRange(checkin, checkout);
      const overlap = newDates.filter(d => blockedWithoutThis.includes(d));
      if (overlap.length > 0) {
        return new Response(JSON.stringify({ 
          error: `Dates overlap with existing bookings: ${overlap.join(', ')}` 
        }), { status: 400, headers: corsHeaders(request) });
      }

      // Recalculate price
      const nights = calculateNights(checkin, checkout);
      const price = calculatePrice(homestay.ownerPrice, nights);

      // Update booking
      bookings[idx].checkin = checkin;
      bookings[idx].checkout = checkout;
      bookings[idx].nights = nights;
      bookings[idx].base = price.base;
      bookings[idx].fee = price.fee;
      bookings[idx].gatewayFee = price.gatewayFee;
      bookings[idx].total = price.total;
      bookings[idx].youReceive = price.youReceive;
      bookings[idx].statusUpdated = new Date().toISOString();

      // Update availability
      if (!availabilityMap[homestay.id]) availabilityMap[homestay.id] = [];
      availabilityMap[homestay.id] = availabilityMap[homestay.id].filter(d => !oldDates.includes(d));
      newDates.forEach(d => {
        if (!availabilityMap[homestay.id].includes(d)) availabilityMap[homestay.id].push(d);
      });
      availabilityMap[homestay.id].sort();

      // Save all changes
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_availability", JSON.stringify(availabilityMap))
        .run();

      return new Response(JSON.stringify({
        success: true,
        message: `Booking dates updated to ${checkin} → ${checkout}`,
        booking: bookings[idx]
      }), { status: 200, headers: corsHeaders(request) });
    }

    // ========== ACTION: CONFIRM CHECK-IN ==========
    if (action === "confirmCheckin") {
      // Check if already checked in
      if (booking.payoutDate) {
        return new Response(JSON.stringify({
          success: false,
          message: `Booking ${bookingId} already checked in on ${booking.payoutDate}`
        }), { status: 200, headers: corsHeaders(request) });
      }

      // Check if paid
      if (!booking.status || !booking.status.toLowerCase().includes("paid")) {
        return new Response(JSON.stringify({ 
          error: "Booking is not paid yet. Cannot check-in." 
        }), { status: 400, headers: corsHeaders(request) });
      }

      // Call the payout API
      const ownerAmount = booking.base || 0;
      const yourFee = booking.youReceive || booking.fee || 0;

      // Get owner bank details from homestay
      const rApproved = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let homestays = [];
      if (rApproved && rApproved.data) { try { homestays = JSON.parse(rApproved.data); } catch(e) {} }
      const rPending = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if (rPending && rPending.data) { try { homestays = [...homestays, ...JSON.parse(rPending.data)]; } catch(e) {} }
      const homestay = homestays.find(h => String(h.id) === String(booking.homestayId));

      if (!homestay) {
        return new Response(JSON.stringify({ error: "Homestay not found" }), { status: 404, headers: corsHeaders(request) });
      }

      // Get the bank code from the booking (which came from the homestay)
      const ownerBankCode = booking.ownerBankCode || homestay.bankCode || 'MBBEMYKL';

      // Use PUBLIC_DOMAIN from env
      const publicDomain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';

      // Now trigger the actual payout
      const payoutReq = await fetch(`${publicDomain}/api/payout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingId: booking.id,
          homestayId: booking.homestayId,
          homestay: booking.homestay,
          amount: ownerAmount,
          ownerAmount: ownerAmount,
          yourFee: yourFee,
          fee: booking.fee,
          total: booking.total,
          ownerBankCode: ownerBankCode,
          ownerAcc: homestay.ownerBankAccount || '',
          ownerName: homestay.bankHolder || homestay.ownerName || 'Owner',
          checkin: booking.checkin
        })
      });

      const payoutData = await payoutReq.json().catch(() => ({}));

      // Update booking status
      bookings[idx].status = "Completed - Owner Paid via Owner Check-in";
      bookings[idx].payoutDate = new Date().toISOString();
      bookings[idx].payoutAmount = ownerAmount;
      bookings[idx].completedDate = new Date().toISOString();
      bookings[idx].ownerPayoutId = payoutData?.payoutId || payoutData?.payoutCode || "OWNER_" + Date.now();

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();

      // Return the success message with the fee
      const finalFee = yourFee < 0 ? 0 : yourFee;
      return new Response(JSON.stringify({
        success: true,
        message: `✅ Check-in confirmed! You (${homestay.ownerName}) will receive RM${ownerAmount} in 1-4 business days.`,
        booking: bookings[idx],
        payout: payoutData
      }), { status: 200, headers: corsHeaders(request) });
    }

    // ========== ACTION: CANCEL BOOKING ==========
    if (action === "cancelBooking") {
      // Check if already completed or cancelled
      if (booking.payoutDate) {
        return new Response(JSON.stringify({
          success: false,
          message: `Booking ${bookingId} already completed and paid out on ${booking.payoutDate}. Cannot cancel.`
        }), { status: 400, headers: corsHeaders(request) });
      }
      if (booking.status && booking.status.toLowerCase().includes('cancelled')) {
        return new Response(JSON.stringify({
          success: false,
          message: `Booking ${bookingId} is already cancelled.`
        }), { status: 400, headers: corsHeaders(request) });
      }

      // Update status to Cancelled
      bookings[idx].status = "Cancelled by Host";
      bookings[idx].statusUpdated = new Date().toISOString();

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();

      await logAction({
        db,
        action: 'booking_cancelled_by_host',
        admin: 'owner',
        details: `Booking ${bookingId} cancelled by host ${ownerData.whatsapp}`,
        ip: clientIP,
        userId: booking.guestEmail,
        homestayId: booking.homestayId
      });

      return new Response(JSON.stringify({
        success: true,
        message: `Booking ${bookingId} has been cancelled.`
      }), { status: 200, headers: corsHeaders(request) });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: corsHeaders(request) });

  } catch (e) {
    console.error("❌ Owner update booking error:", e.message);
    return new Response(JSON.stringify({ error: "Server error: " + e.message }), { status: 500, headers: corsHeaders(request) });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
