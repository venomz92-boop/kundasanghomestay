// /api/owner-update-booking.js — Plain English: this file handles host
// actions: block/unblock a room date, change the nightly price, shift a
// booking's dates, and cancel a booking (with automatic refund).
//
// [THIS REVISION]
// Cancellation now distinguishes two cases:
//
//   cancelType: 'host_own'      — host cancels for their own reasons
//                                 (overbooking, maintenance, emergency).
//                                 Guest receives a FULL refund of everything
//                                 they paid, including the service fee.
//
//   cancelType: 'guest_request' — guest asked to cancel, host approved.
//                                 Guest receives the BASE amount only.
//                                 The service fee and gateway fee are
//                                 retained by the platform, per policy.
//
// The refund amount, the booking status, and the cancellation email all
// reflect which case applies. Missing cancelType defaults to 'host_own'
// (the safer of the two: refund more, not less).
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  getOwnerSession,
  jsonResponse,
  withLock,
  getOwnerHomestayIdsFresh
} from './_utils.js';

const MAX_NIGHTS = 60;
const GATEWAY_FEE = 1.00;

const BOOKINGS_LOCK = 'bookings-global';

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
  const gatewayFee = GATEWAY_FEE;
  const total = base + fee + gatewayFee;
  return { nights, base, fee, gatewayFee, total, youReceive: base };
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

async function processChipRefund(purchaseId, amount, env) {
  const chipSecret = env.CHIP_SECRET_KEY;
  if (!chipSecret) throw new Error('CHIP_SECRET_KEY not configured – cannot process refund');
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

  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }

  if (!response.ok || !data || !data.id) {
    const errMsg = data?.error || data?.message || `HTTP ${response.status}`;
    throw new Error(`CHIP refund failed: ${errMsg}`);
  }
  return data;
}

function isOwnerPaidOut(booking) {
  if (!booking) return false;
  if (booking.payoutSuccessDate) return true;
  if (booking.ownerPayoutId) return true;
  if (booking.payoutSuccess === true && booking.payoutAmount > 0) return true;
  const s = String(booking.status || '').toLowerCase();
  if (s.startsWith('completed')) return true;
  return false;
}

function isPaidBooking(booking) {
  if (!booking) return false;
  const s = String(booking.status || '');
  if (s === 'Paid - Awaiting Check-in') return true;
  if (s === 'Completed - Payout Pending') return true;
  if (s.startsWith('Completed')) return true;
  return false;
}

// ============================================================
// Cancellation email — best-effort, never blocks the cancel.
//
// Three payment outcomes × two cancel reasons:
//   - refund fully processed
//   - refund pending at CHIP
//   - refund FAILED (needs manual review)
//   - no refund needed (unpaid booking)
//
// The wording reflects whether this was a host-own cancellation
// (full refund) or a guest-request cancellation (base refund, fee
// retained by platform).
// ============================================================
async function sendCancellationEmail(booking, refundInfo, env) {
  if (!booking || !booking.guestEmail) {
    return { sent: false, error: 'No guest email on file' };
  }

  const safe = (s) => String(s || '').replace(/[<>]/g, '');
  const cancelType = String(refundInfo.cancelType || 'host_own');
  const isGuestRequest = cancelType === 'guest_request';

  const refundAmountNum = Number(
    refundInfo.refundAmount ||
    (isGuestRequest ? booking.base : (booking.amount_paid || booking.total)) ||
    0
  );
  const refundAmount = refundAmountNum.toFixed(2);
  const totalPaidNum = Number(booking.amount_paid || booking.total || 0);
  const totalPaid = totalPaidNum.toFixed(2);
  const feeRetainedNum = Math.max(0, totalPaidNum - refundAmountNum);
  const feeRetained = feeRetainedNum.toFixed(2);

  const initiatedBy = isGuestRequest
    ? 'at your request and confirmed by the host'
    : 'by the host';

  let subject, headerColor, headerText, bodyHtml;

  if (refundInfo.isPaid && refundInfo.refundSuccess && !refundInfo.refundPending) {
    subject = isGuestRequest
      ? 'Booking Cancelled at Your Request - Refund Processed'
      : 'Booking Cancelled by Host - Refund Processed';
    headerColor = '#16a34a';
    headerText = '✓ Booking Cancelled — Refund Processed';

    const refundNote = isGuestRequest
      ? `
        <p>Per our cancellation policy, the platform service fee and payment gateway fee are <strong>non-refundable</strong> on guest-requested cancellations.</p>
        <p>A refund of <strong>RM${refundAmount}</strong> has been processed to your original payment method via CHIP. This represents the base nightly rate.</p>
        <table style="font-size:13px;margin:12px 0;">
          <tr>
            <td style="padding:4px 12px 4px 0;color:#6b7280;">You paid</td>
            <td style="padding:4px 0;font-weight:600;">RM ${totalPaid}</td>
          </tr>
          <tr>
            <td style="padding:4px 12px 4px 0;color:#6b7280;">Service fee retained</td>
            <td style="padding:4px 0;font-weight:600;">− RM ${feeRetained}</td>
          </tr>
          <tr style="border-top:1px solid #e5e7eb;">
            <td style="padding:6px 12px 4px 0;color:#0F382E;font-weight:700;">Refunded to you</td>
            <td style="padding:6px 0;color:#0F382E;font-weight:800;">RM ${refundAmount}</td>
          </tr>
        </table>
      `
      : `
        <p>A <strong>full refund of RM${refundAmount}</strong> has been processed to your original payment method via CHIP.</p>
      `;

    bodyHtml = `
      <p>Your booking at <strong>${safe(booking.homestay)}</strong> has been cancelled ${initiatedBy}.</p>
      ${refundNote}
      <p>Refunds typically take <strong>3–7 business days</strong> to appear in your bank account, depending on your bank's processing times.</p>
      <p><strong>Refund ID (CHIP):</strong> ${safe(refundInfo.refundId || 'N/A')}</p>
    `;
  } else if (refundInfo.isPaid && refundInfo.refundSuccess && refundInfo.refundPending) {
    subject = isGuestRequest
      ? 'Booking Cancelled at Your Request - Refund Processing'
      : 'Booking Cancelled by Host - Refund Processing';
    headerColor = '#d97706';
    headerText = '⏳ Booking Cancelled — Refund Processing';

    const pendingNote = isGuestRequest
      ? `<p>A refund of <strong>RM${refundAmount}</strong> is being processed by CHIP. Per policy, the platform service fee of <strong>RM${feeRetained}</strong> is retained on guest-requested cancellations.</p>`
      : `<p>A <strong>full refund of RM${refundAmount}</strong> is being processed by CHIP. This usually completes within a few minutes.</p>`;

    bodyHtml = `
      <p>Your booking at <strong>${safe(booking.homestay)}</strong> has been cancelled ${initiatedBy}.</p>
      ${pendingNote}
      <p>Once CHIP finishes, the refund may take a further <strong>3–7 business days</strong> to appear in your bank account.</p>
      <p><strong>Refund ID (CHIP):</strong> ${safe(refundInfo.refundId || 'N/A')}</p>
    `;
  } else if (refundInfo.isPaid && !refundInfo.refundSuccess) {
    subject = 'Booking Cancelled';
    headerColor = '#dc2626';
    headerText = '❌ Booking Cancelled — Refund Pending Review';
    bodyHtml = `
      <p>Your booking at <strong>${safe(booking.homestay)}</strong> has been cancelled ${initiatedBy}.</p>
      <p>Your payment of <strong>RM${totalPaid}</strong> was taken. The refund could not be processed automatically and is now under manual review by our team.</p>
      <p>Please contact <a href="mailto:support@kundasanghomestay.my">support@kundasanghomestay.my</a> if you don't hear from us within 24 hours.</p>
    `;
  } else {
    subject = 'Booking Cancelled';
    headerColor = '#6b7280';
    headerText = '❌ Booking Cancelled';
    bodyHtml = `
      <p>Your booking at <strong>${safe(booking.homestay)}</strong> has been cancelled ${initiatedBy}.</p>
      <p>No payment was taken for this booking, so no refund is needed.</p>
      <p>If you have any questions, please contact the host directly.</p>
    `;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:${headerColor};">${headerText}</h2>
      <p>Hello ${safe(booking.guestName || 'Guest')},</p>
      ${bodyHtml}
      <div style="background:#f8f5f0;padding:16px;border-radius:8px;margin:16px 0;font-size:13px;">
        <div><strong>Booking ID:</strong> ${safe(booking.id)}</div>
        <div><strong>Homestay:</strong> ${safe(booking.homestay)}</div>
        <div><strong>Check-in:</strong> ${safe(booking.checkin)}</div>
        <div><strong>Check-out:</strong> ${safe(booking.checkout)}</div>
        <div><strong>Nights:</strong> ${safe(booking.nights)}</div>
        <div><strong>Cancellation reason:</strong> ${isGuestRequest ? 'Guest request (approved by host)' : 'Host-initiated'}</div>
      </div>
      <p>— Kundasang Homestay Team</p>
    </div>
  `;

  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: booking.guestEmail,
          subject,
          html
        })
      });
      return { sent: r.ok, error: r.ok ? null : 'Resend API error' };
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: booking.guestEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject,
          content: [{ type: 'text/html', value: html }]
        })
      });
      return { sent: r.ok, error: r.ok ? null : 'SendGrid API error' };
    }
    return { sent: false, error: 'No email provider configured' };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const clientIP = getClientIP(request);

  try {
    const ownerData = await verifyOwner(request, env);
    if (!ownerData || ownerData.type !== 'owner') {
      return jsonResponse({ error: 'Unauthorized' }, 401, request);
    }

    const body = await request.json();
    const { bookingId, checkin, checkout, action } = body;

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const ownerHomestayIds = await getOwnerHomestayIdsFresh(db, ownerData);

    // ===== ACTION: Update room block (LOCK PROTECTED) =====
    if (action === 'updateRoomBlock') {
      const { homestayId, roomId, date } = body;
      if (!homestayId || !roomId || !date) {
        return jsonResponse({ error: 'Missing homestayId, roomId, or date' }, 400, request);
      }

      if (!ownerHomestayIds.map(String).includes(String(homestayId))) {
        return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const rApproved = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
          let homestays = [];
          if (rApproved && rApproved.data) { try { homestays = JSON.parse(rApproved.data); } catch (e) {} }
          const rPending = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
          if (rPending && rPending.data) { try { homestays = [...homestays, ...JSON.parse(rPending.data)]; } catch (e) {} }

          const homestay = homestays.find(h => String(h.id) === String(homestayId));
          if (!homestay) return { error: 'Homestay not found', status: 404 };

          if (!homestay.rooms) homestay.rooms = [];
          const room = homestay.rooms.find(r => r.id === roomId);
          if (!room) return { error: 'Room not found', status: 404 };

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
            const res = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
            let arr = [];
            if (res && res.data) { try { arr = JSON.parse(res.data); } catch (e) {} }
            const index = arr.findIndex(h => String(h.id) === String(homestayId));
            if (index !== -1) {
              arr[index] = homestay;
              await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
                .bind(key, JSON.stringify(arr))
                .run();
              updated = true;
            }
          }
          if (!updated) return { error: 'Failed to save update', status: 500 };

          return { success: true, message, room };
        }, 15000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) return jsonResponse({ error: result.error }, result.status || 400, request);

      await logAction({
        db,
        action: 'room_block_toggle',
        admin: 'owner',
        details: `${result.message} (room: ${result.room.name})`,
        ip: clientIP,
        userId: ownerData.ownerId,
        homestayId: homestayId
      });

      return jsonResponse({ success: true, message: result.message, room: result.room }, 200, request);
    }

    // ===== ACTION: Update homestay price (LOCK PROTECTED) =====
    if (action === 'updateHomestayPrice') {
      const { homestayId, newPrice } = body;
      if (!homestayId || newPrice === undefined || newPrice === null) {
        return jsonResponse({ error: 'Missing homestayId or newPrice' }, 400, request);
      }

      if (!ownerHomestayIds.map(String).includes(String(homestayId))) {
        return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
      }

      const priceNum = Number(newPrice);
      if (isNaN(priceNum) || priceNum < 0) {
        return jsonResponse({ error: 'Invalid price (must be a positive number)' }, 400, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          let updated = false;
          for (const key of ['kd_approved', 'kd_pending']) {
            const res = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
            let arr = [];
            if (res && res.data) { try { arr = JSON.parse(res.data); } catch (e) {} }
            const index = arr.findIndex(h => String(h.id) === String(homestayId));
            if (index !== -1) {
              arr[index].ownerPrice = priceNum;
              await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
                .bind(key, JSON.stringify(arr))
                .run();
              updated = true;
            }
          }
          if (!updated) return { error: 'Homestay not found in any store', status: 404 };
          return { success: true };
        }, 15000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) return jsonResponse({ error: result.error }, result.status || 400, request);

      await logAction({
        db,
        action: 'homestay_price_update',
        admin: 'owner',
        details: `Price updated for homestay ${homestayId} to RM ${priceNum}`,
        ip: clientIP,
        userId: ownerData.ownerId,
        homestayId: homestayId
      });

      return jsonResponse({
        success: true,
        message: `Price updated to RM ${priceNum}`,
        newPrice: priceNum
      }, 200, request);
    }

    // ===== Other actions need bookingId =====
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    // ========== ACTION: CHANGE DATES ==========
    if (action === 'changeDates') {
      if (!checkin || !checkout) {
        return jsonResponse({ error: 'Missing checkin or checkout' }, 400, request);
      }

      const d1 = new Date(checkin);
      const d2 = new Date(checkout);
      if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
        return jsonResponse({ error: 'Invalid dates' }, 400, request);
      }

      const nights = calculateNights(checkin, checkout);
      if (nights > MAX_NIGHTS) {
        return jsonResponse({ error: `Maximum booking length is ${MAX_NIGHTS} nights.` }, 400, request);
      }

      const preRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      let preBookings = [];
      try { if (preRes?.data) preBookings = JSON.parse(preRes.data); } catch (_) {}
      const preBooking = preBookings.find(b => String(b.id) === String(bookingId));
      if (!preBooking) return jsonResponse({ error: 'Invalid request.' }, 400, request);

      if (!ownerHomestayIds.map(String).includes(String(preBooking.homestayId))) {
        return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
      }

      if (isOwnerPaidOut(preBooking)) {
        return jsonResponse({
          error: 'This booking has already been completed and paid out to you. Dates cannot be changed anymore.'
        }, 400, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          let bookings = [];
          try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
          const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
          if (idx === -1) return { error: 'Booking not found', status: 404 };

          const booking = bookings[idx];

          if (isOwnerPaidOut(booking)) {
            return {
              error: 'Booking was completed and paid out while you were editing. Refresh and try again.',
              status: 409
            };
          }

          const isPaid = isPaidBooking(booking);

          if (isPaid) {
            const originalNights = Number(booking.nights) || 1;
            if (nights !== originalNights) {
              return {
                error: `This booking is already paid for ${originalNights} night${originalNights !== 1 ? 's' : ''}. You can shift the dates but the length must stay the same. To change the length, please cancel the booking (the guest gets an automatic refund) and ask them to rebook.`,
                status: 400
              };
            }
          }

          const rApproved = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
          let homestays = [];
          try { if (rApproved?.data) homestays = JSON.parse(rApproved.data); } catch (e) {}
          const rPending = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
          if (rPending?.data) { try { homestays = [...homestays, ...JSON.parse(rPending.data)]; } catch (e) {} }

          const homestay = homestays.find(h => String(h.id) === String(booking.homestayId));
          if (!homestay) return { error: 'Homestay not found', status: 404 };

          const newDates = getDatesInRange(checkin, checkout);

          const otherBookingsBlocked = new Set();
          for (const b of bookings) {
            if (String(b.id) === String(bookingId)) continue;
            if (/cancelled|failed|expired|refunded/i.test(String(b.status || ''))) continue;
            if (booking.roomId) {
              if (String(b.roomId) !== String(booking.roomId)) continue;
            } else {
              if (String(b.homestayId) !== String(homestay.id)) continue;
            }
            for (const d of getDatesInRange(b.checkin, b.checkout)) otherBookingsBlocked.add(d);
          }

          const homestayBlocked = new Set((homestay.blockedDates || []).map(String));
          const roomBlocked = new Set();
          if (booking.roomId && homestay.rooms) {
            const room = homestay.rooms.find(r => String(r.id) === String(booking.roomId));
            if (room && Array.isArray(room.blockedDates)) {
              for (const d of room.blockedDates) roomBlocked.add(d);
            }
          }

          const conflicts = [];
          for (const d of newDates) {
            if (otherBookingsBlocked.has(d)) conflicts.push(d);
            else if (homestayBlocked.has(d)) conflicts.push(d);
            else if (roomBlocked.has(d)) conflicts.push(d);
          }
          if (conflicts.length > 0) {
            return { error: `Dates overlap with existing bookings: ${conflicts.join(', ')}`, status: 400 };
          }

          bookings[idx].checkin = checkin;
          bookings[idx].checkout = checkout;
          bookings[idx].nights = nights;
          bookings[idx].statusUpdated = new Date().toISOString();

          if (!isPaid) {
            const price = calculatePrice(homestay.ownerPrice, nights);
            bookings[idx].base = price.base;
            bookings[idx].fee = price.fee;
            bookings[idx].gatewayFee = price.gatewayFee;
            bookings[idx].total = price.total;
            bookings[idx].youReceive = price.youReceive;
          } else {
            bookings[idx].paidDateShiftedAt = new Date().toISOString();
          }

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          return { success: true, booking: bookings[idx], isPaid };
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({
            error: 'Another booking operation is in progress. Please try again in a moment.'
          }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) {
        return jsonResponse({ error: result.error }, result.status || 400, request);
      }

      await logAction({
        db,
        action: result.isPaid ? 'booking_dates_shifted_paid_owner' : 'booking_dates_changed_owner',
        admin: 'owner',
        details: `Booking ${bookingId} dates → ${checkin} → ${checkout}${result.isPaid ? ' (paid — same-length shift, price unchanged)' : ''}`,
        ip: clientIP,
        userId: ownerData.ownerId,
        homestayId: preBooking.homestayId
      });

      return jsonResponse({
        success: true,
        message: `Booking dates updated to ${checkin} → ${checkout}` + (result.isPaid ? ' (paid amount unchanged).' : ''),
        booking: result.booking
      }, 200, request);
    }

    // ========== ACTION: CANCEL BOOKING (LOCK PROTECTED) ==========
    if (action === 'cancelBooking') {
      // [NEW] cancelType distinguishes host-own from guest-request.
      // Missing value defaults to 'host_own' (the safer case: full refund).
      const cancelTypeRaw = String(body.cancelType || 'host_own').toLowerCase().trim();
      const cancelType = (cancelTypeRaw === 'guest_request') ? 'guest_request' : 'host_own';

      const preRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      let preBookings = [];
      try { if (preRes?.data) preBookings = JSON.parse(preRes.data); } catch (_) {}
      const preBooking = preBookings.find(b => String(b.id) === String(bookingId));
      if (!preBooking) return jsonResponse({ error: 'Invalid request.' }, 400, request);

      if (!ownerHomestayIds.map(String).includes(String(preBooking.homestayId))) {
        return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          let bookings = [];
          try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
          const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
          if (idx === -1) return { error: 'Booking not found', status: 404 };

          const booking = bookings[idx];

          if (isOwnerPaidOut(booking)) {
            return {
              error: `Booking ${bookingId} has already been completed and paid out. Cannot cancel.`,
              status: 400
            };
          }
          if (booking.status && booking.status.toLowerCase().includes('cancelled')) {
            return { error: `Booking ${bookingId} is already cancelled.`, status: 400 };
          }
          if (booking.chip_refund_id) {
            return { error: 'This booking has already been refunded.', status: 400 };
          }

          if (booking.refund_attempted_at && !booking.chip_refund_id) {
            return {
              error: `A refund was already attempted for this booking at ${booking.refund_attempted_at}. Log into the CHIP dashboard and check purchase ${booking.chip_purchase_id || '(unknown)'} before retrying. If no refund exists, contact support to clear the marker.`,
              status: 409
            };
          }

          const isPaid = isPaidBooking(booking);

          // Compute refund amount based on cancel type.
          //   host_own:      refund the full amount the guest paid
          //   guest_request: refund only the base (host's nightly rate);
          //                  the platform service fee + gateway fee are
          //                  retained by the platform per policy
          const totalPaidNum = Number(booking.amount_paid || booking.total) || 0;
          const baseAmountNum = Number(booking.base) || 0;
          const refundAmountNum = cancelType === 'guest_request'
            ? baseAmountNum
            : totalPaidNum;

          let refundSuccess = false;
          let refundData = null;
          let refundError = null;

          if (isPaid && booking.chip_purchase_id && refundAmountNum > 0) {
            bookings[idx].refund_attempted_at = new Date().toISOString();
            bookings[idx].refund_attempted_by = 'host';
            bookings[idx].refund_attempted_amount = refundAmountNum;
            await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_bookings', JSON.stringify(bookings))
              .run();

            try {
              refundData = await processChipRefund(
                booking.chip_purchase_id,
                refundAmountNum,
                env
              );
              refundSuccess = true;
            } catch (err) {
              refundError = err.message;
            }
          }

          // Status string reflects both the cancel reason and the refund state.
          const cancelledByLabel = cancelType === 'guest_request'
            ? 'Cancelled by Guest Request (host approved)'
            : 'Cancelled by Host';

          if (isPaid && refundSuccess) {
            const isPending = refundData && refundData.status === 'pending_refund';
            bookings[idx].status = isPending
              ? 'Refund Pending - Awaiting CHIP'
              : 'Refunded';
            bookings[idx].chip_refund_id = refundData.id;
            bookings[idx].refunded_at = new Date().toISOString();
            bookings[idx].refund_amount = refundAmountNum;
            bookings[idx].cancelled_by = 'host';
            bookings[idx].cancel_type = cancelType;
            bookings[idx].statusUpdated = new Date().toISOString();
            if (isPending) bookings[idx].refund_pending = true;
          } else if (isPaid && !refundSuccess) {
            bookings[idx].status = 'Cancelled by Host - Refund Pending';
            bookings[idx].refund_error = refundError || 'Unknown error';
            bookings[idx].cancelled_by = 'host';
            bookings[idx].cancel_type = cancelType;
            bookings[idx].statusUpdated = new Date().toISOString();
          } else {
            bookings[idx].status = cancelledByLabel;
            bookings[idx].cancelled_by = 'host';
            bookings[idx].cancel_type = cancelType;
            bookings[idx].statusUpdated = new Date().toISOString();
          }

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          return {
            success: true,
            isPaid,
            cancelType,
            refundAmountNum,
            refundSuccess,
            refundData,
            refundError,
            refundPending: refundData && refundData.status === 'pending_refund',
            booking: bookings[idx]
          };
        }, 60000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({
            error: 'Another booking operation is in progress. Please wait a moment and try again.'
          }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) {
        return jsonResponse({ error: result.error }, result.status || 400, request);
      }

      // Send the cancellation email to the guest. Best-effort:
      // an email failure never rolls back the cancellation or refund.
      let emailReport = { sent: false, error: 'skipped' };
      try {
        emailReport = await sendCancellationEmail(result.booking, {
          isPaid: result.isPaid,
          cancelType: result.cancelType,
          refundAmount: result.refundAmountNum,
          refundSuccess: result.refundSuccess,
          refundPending: result.refundPending || false,
          refundId: result.refundData?.id || null
        }, env);
      } catch (mailErr) {
        console.error('Cancellation email error:', mailErr.message);
        emailReport = { sent: false, error: mailErr.message };
      }

      await logAction({
        db,
        action: result.isPaid
          ? (result.refundSuccess
              ? (result.refundPending ? 'booking_cancelled_host_refund_pending' : 'booking_cancelled_host_refund_success')
              : 'booking_cancelled_host_refund_failed')
          : 'booking_cancelled_host',
        admin: 'owner',
        details: `Booking ${bookingId} cancelled by host ${ownerData.whatsapp} — type=${result.cancelType}. ${
          result.isPaid
            ? (result.refundSuccess
                ? (result.refundPending
                    ? `Refund pending (CHIP still processing): ${result.refundData.id}, RM${result.refundAmountNum.toFixed(2)}`
                    : `Refund processed: ${result.refundData.id}, RM${result.refundAmountNum.toFixed(2)}`)
                : 'Refund failed: ' + result.refundError)
            : '(unpaid)'
        }. Cancellation email: ${emailReport.sent ? 'sent' : 'failed — ' + (emailReport.error || 'unknown')}`,
        ip: clientIP,
        userId: result.booking.guestEmail,
        homestayId: result.booking.homestayId
      });

      // Response message reflects the two cases.
      const refundMsg = (() => {
        if (!result.isPaid) {
          return `Booking ${bookingId} cancelled (unpaid).`;
        }
        if (result.refundSuccess) {
          const amt = Number(result.refundAmountNum).toFixed(2);
          if (result.refundPending) {
            return `Booking ${bookingId} cancelled. CHIP is processing the refund of RM${amt} — this can take a few minutes. The guest will be notified when complete.`;
          }
          if (result.cancelType === 'guest_request') {
            return `Booking ${bookingId} cancelled at guest request. Refund of RM${amt} processed (base amount only; service fee retained).`;
          }
          return `Booking ${bookingId} cancelled and full refund of RM${amt} processed.`;
        }
        return `Booking ${bookingId} cancelled but refund failed. Status set to 'Refund Pending'. Please contact support.`;
      })();

      return jsonResponse({
        success: true,
        message: refundMsg,
        cancelType: result.cancelType,
        refundAmount: result.refundAmountNum,
        booking: result.booking,
        refund: result.refundData || undefined,
        refundError: result.refundError || undefined,
        refundPending: result.refundPending || false,
        emailSent: emailReport.sent
      }, 200, request);
    }

    return jsonResponse({ error: 'Invalid action' }, 400, request);

  } catch (e) {
    console.error('Owner update booking error:', e.message);
    return jsonResponse({ error: 'An error occurred while processing your request.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
