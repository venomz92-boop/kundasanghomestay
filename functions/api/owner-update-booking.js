// /api/owner-update-booking.js - With automatic refund on host cancellation + security fixes
import { corsHeaders, getClientIP, logAction, enforceHttps, getOwnerSession, jsonResponse } from './_utils.js';

const MAX_NIGHTS = 60;

async function verifyOwner(request, env) { return getOwnerSession(request, env); }

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

// ============================================================
// NEW: Refund helper using CHIP API
// ============================================================
async function processChipRefund(purchaseId, amount, env) {
  const chipSecret = env.CHIP_SECRET_KEY;
  if (!chipSecret) {
    throw new Error('CHIP_SECRET_KEY not configured – cannot process refund');
  }
  const amountCents = Math.round(amount * 100);
  const payload = { amount: amountCents };

  const response = await fetch(`https://gate.chip-in.asia/api/v1/purchases/${purchaseId}/refund/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${chipSecret}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok || !data.id) {
    throw new Error(`CHIP refund failed: ${data.error || 'unknown'}`);
  }
  return data;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const clientIP = getClientIP(request);

  try {
    const ownerData = await verifyOwner(request, env);
    if (!ownerData || ownerData.type !== 'owner') {
      return jsonResponse({ error: "Unauthorized" }, 401, request);
    }

    const body = await request.json();
    const { bookingId, checkin, checkout, action } = body;

    // ===== ACTION: Update room block =====
    if (action === "updateRoomBlock") {
      const { homestayId, roomId, date } = body;
      if (!homestayId || !roomId || !date) {
        return jsonResponse({ error: 'Missing homestayId, roomId, or date' }, 400, request);
      }

      const ownerHomestayIds = (ownerData.homestayIds || []).map(String);
      if (!ownerHomestayIds.includes(String(homestayId))) {
        return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
      }

      const db = env.DB;
      if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

      const rApproved = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let homestays = [];
      if (rApproved && rApproved.data) { try { homestays = JSON.parse(rApproved.data); } catch(e) {} }
      const rPending = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if (rPending && rPending.data) { try { homestays = [...homestays, ...JSON.parse(rPending.data)]; } catch(e) {} }

      const homestay = homestays.find(h => String(h.id) === String(homestayId));
      if (!homestay) return jsonResponse({ error: 'Homestay not found' }, 404, request);

      if (!homestay.rooms) homestay.rooms = [];
      const room = homestay.rooms.find(r => r.id === roomId);
      if (!room) return jsonResponse({ error: 'Room not found' }, 404, request);

      if (!room.blockedDates) room.blockedDates = [];

      const idx = room.blockedDates.indexOf(date);
      let message = '';
      if (idx !== -1) {
        room.blockedDates.splice(idx, 1);
        message = `Unblocked ${date} for ${room.name}`;
      } else {
        room.blockedDates.push(date);
        room.blockedDates.sort();
        message = `Blocked ${date} for ${room.name}`;
      }

      let updated = false;
      for (const key of ['kd_approved', 'kd_pending']) {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind(key).first();
        let arr = [];
        if (res && res.data) { try { arr = JSON.parse(res.data); } catch(e) {} }
        const index = arr.findIndex(h => String(h.id) === String(homestayId));
        if (index !== -1) {
          arr[index] = homestay;
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind(key, JSON.stringify(arr))
            .run();
          updated = true;
        }
      }
      if (!updated) return jsonResponse({ error: 'Failed to save update' }, 500, request);

      await logAction({
        db,
        action: 'room_block_toggle',
        admin: 'owner',
        details: `${message} (room: ${room.name})`,
        ip: clientIP,
        userId: ownerData.ownerId,
        homestayId: homestayId
      });

      return jsonResponse({ success: true, message, room }, 200, request);
    }

    // ===== Existing actions (changeDates, cancelBooking) – with security fixes =====
    if (!bookingId) {
      return jsonResponse({ error: "Missing bookingId" }, 400, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: "Server error" }, 500, request);
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res && res.data) { try { bookings = JSON.parse(res.data); } catch(e) {} }

    const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
    if (idx === -1) return jsonResponse({ error: "Booking not found" }, 404, request);

    const booking = bookings[idx];

    // SECURITY: Verify this owner owns this homestay
    if (!(ownerData.homestayIds || [ownerData.ownerId]).map(String).includes(String(booking.homestayId))) {
      console.warn(`⚠️ Owner ${ownerData.whatsapp} tried to modify booking for homestay ${booking.homestayId} but owns ${ownerData.ownerId}`);
      return jsonResponse({ error: "Unauthorized: You do not own this homestay" }, 403, request);
    }

    // ========== ACTION: CHANGE DATES ==========
    if (action === "changeDates") {
      if (!checkin || !checkout) {
        return jsonResponse({ error: "Missing checkin or checkout" }, 400, request);
      }

      const d1 = new Date(checkin);
      const d2 = new Date(checkout);
      if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
        return jsonResponse({ error: "Invalid dates" }, 400, request);
      }
      // SECURITY: Enforce max nights
      const nights = calculateNights(checkin, checkout);
      if (nights > MAX_NIGHTS) {
        return jsonResponse({ error: `Maximum booking length is ${MAX_NIGHTS} nights.` }, 400, request);
      }

      // ... rest of date change logic (unchanged) ...
      const rApproved = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let homestays = [];
      if (rApproved && rApproved.data) { try { homestays = JSON.parse(rApproved.data); } catch(e) {} }
      const rPending = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if (rPending && rPending.data) { try { homestays = [...homestays, ...JSON.parse(rPending.data)]; } catch(e) {} }

      const homestay = homestays.find(h => String(h.id) === String(booking.homestayId));
      if (!homestay) return jsonResponse({ error: "Homestay not found" }, 404, request);

      const oldDates = getDatesInRange(booking.checkin, booking.checkout);
      
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
        return jsonResponse({ 
          error: `Dates overlap with existing bookings: ${overlap.join(', ')}` 
        }, 400, request);
      }

      const price = calculatePrice(homestay.ownerPrice, nights);

      bookings[idx].checkin = checkin;
      bookings[idx].checkout = checkout;
      bookings[idx].nights = nights;
      bookings[idx].base = price.base;
      bookings[idx].fee = price.fee;
      bookings[idx].gatewayFee = price.gatewayFee;
      bookings[idx].total = price.total;
      bookings[idx].youReceive = price.youReceive;
      bookings[idx].statusUpdated = new Date().toISOString();

      if (!availabilityMap[homestay.id]) availabilityMap[homestay.id] = [];
      availabilityMap[homestay.id] = availabilityMap[homestay.id].filter(d => !oldDates.includes(d));
      newDates.forEach(d => {
        if (!availabilityMap[homestay.id].includes(d)) availabilityMap[homestay.id].push(d);
      });
      availabilityMap[homestay.id].sort();

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_availability", JSON.stringify(availabilityMap))
        .run();

      return jsonResponse({
        success: true,
        message: `Booking dates updated to ${checkin} → ${checkout}`,
        booking: bookings[idx]
      }, 200, request);
    }

    // ========== ACTION: CANCEL BOOKING ==========
    if (action === "cancelBooking") {
      // Check if already completed or cancelled
      if (booking.payoutDate) {
        return jsonResponse({
          success: false,
          message: `Booking ${bookingId} already completed and paid out on ${booking.payoutDate}. Cannot cancel.`
        }, 400, request);
      }
      if (booking.status && booking.status.toLowerCase().includes('cancelled')) {
        return jsonResponse({
          success: false,
          message: `Booking ${bookingId} is already cancelled.`
        }, 400, request);
      }
      // SECURITY: Prevent double refund
      if (booking.chip_refund_id) {
        return jsonResponse({ success: false, message: 'This booking has already been refunded.' }, 400, request);
      }

      // ============================================================
      // 🔄 NEW: If booking is paid, automatically process refund
      // ============================================================
      const isPaid = booking.status === 'Paid - Awaiting Check-in';
      let refundSuccess = false;
      let refundData = null;
      let refundError = null;

      if (isPaid && booking.chip_purchase_id) {
        try {
          // Refund full amount (total)
          refundData = await processChipRefund(booking.chip_purchase_id, booking.total, env);
          refundSuccess = true;
        } catch (err) {
          refundError = err.message;
          console.error('❌ Host cancellation refund failed:', err);
        }
      }

      // Update booking status
      if (isPaid && refundSuccess) {
        bookings[idx].status = 'Refunded';
        bookings[idx].chip_refund_id = refundData.id; // store refund id for idempotency
        bookings[idx].refunded_at = new Date().toISOString();
        bookings[idx].refund_amount = booking.total;
        bookings[idx].cancelled_by = 'host';
        bookings[idx].statusUpdated = new Date().toISOString();
      } else if (isPaid && !refundSuccess) {
        bookings[idx].status = 'Cancelled by Host - Refund Pending';
        bookings[idx].refund_error = refundError || 'Unknown error';
        bookings[idx].cancelled_by = 'host';
        bookings[idx].statusUpdated = new Date().toISOString();
      } else {
        // Unpaid booking – just cancel
        bookings[idx].status = "Cancelled by Host";
        bookings[idx].cancelled_by = 'host';
        bookings[idx].statusUpdated = new Date().toISOString();
      }

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();

      await logAction({
        db,
        action: isPaid ? (refundSuccess ? 'booking_cancelled_host_refund_success' : 'booking_cancelled_host_refund_failed') : 'booking_cancelled_host',
        admin: 'owner',
        details: `Booking ${bookingId} cancelled by host ${ownerData.whatsapp}. ${isPaid ? (refundSuccess ? 'Refund processed: ' + refundData.id : 'Refund failed: ' + refundError) : '(unpaid)'}`,
        ip: clientIP,
        userId: booking.guestEmail,
        homestayId: booking.homestayId
      });

      return jsonResponse({
        success: true,
        message: isPaid 
          ? (refundSuccess 
              ? `Booking ${bookingId} cancelled and full refund of RM${booking.total.toFixed(2)} processed.`
              : `Booking ${bookingId} cancelled but refund failed. Status set to 'Refund Pending'. Please contact support.`)
          : `Booking ${bookingId} cancelled (unpaid).`,
        booking: bookings[idx],
        refund: refundData || undefined,
        refundError: refundError || undefined
      }, 200, request);
    }

    return jsonResponse({ error: "Invalid action" }, 400, request);

  } catch (e) {
    console.error("❌ Owner update booking error:", e.message);
    // SECURITY: Generic error
    return jsonResponse({ error: "An error occurred while processing your request." }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
