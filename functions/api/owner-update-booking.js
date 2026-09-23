// /api/owner-update-booking.js — Host actions: block/unblock a room date,
// change the nightly price, shift a booking's dates, decide a cancellation
// request (accept or decline), and cancel a booking (with automatic refund).
//
// [CANCELLATION TIERS REVISION]
//   - Refund amounts now come from computeCancellationTier() in _utils.js.
//     This file no longer works out a refund on its own. There must be
//     exactly one copy of that maths, and _utils.js is where it lives.
//   - New action: declineCancellation. The host says no; nothing is
//     cancelled and no money moves. The reason is recorded.
//   - New action: acceptCancellation. The host agrees to a request the
//     guest made through the form, so we have their original date and the
//     tier is fixed by it. Queues the host's own share on Tiers B and C.
//   - cancelBooking still works for a host cancelling for their own
//     reasons, or accepting a request made off-platform. In that case
//     there is no recorded date, so the tier is measured from now.
//   - Tier C now has its own branch. It used to fall into the "refund
//     failed" path, which would tell the guest their refund was under
//     review when in fact nothing was ever due.
//
// Kept as-is (intentionally):
//   - refund_attempted_at is set before the CHIP call, which protects
//     against double refunds.
//   - All writes run under BOOKINGS_LOCK, and the booking plus both
//     ledgers land in one db.batch.
//   - Uses parseJSONSafely() and escHtml() as before.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  getOwnerSession,
  jsonResponse,
  withLock,
  getOwnerHomestayIdsFresh,
  parseJSONSafely,
  escHtml,
  escAttr,
  computeCancellationTier
} from './_utils.js';

const MAX_NIGHTS = 60;
const GATEWAY_FEE = 1.00;

// CHIP's FPX B2C fee schedule (chip-in.asia pricing page):
//   - RM 1.00 per paid transaction
//   - RM 1.00 per refund (FPX B2C only)
// These are hardcoded because CHIP doesn't expose them via API.
// The refund amounts themselves live in computeCancellationTier()
// in _utils.js — do not recompute them here.
const CHIP_PAYMENT_FEE = 1.00;
const CHIP_REFUND_FEE = 1.00;
const CHIP_TOTAL_FEES_PER_CANCELLATION = CHIP_PAYMENT_FEE + CHIP_REFUND_FEE;

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

// Resolve the nightly unit price for a booking. If the booking is on a
// specific room and that room has a numeric price, use the room price.
// Otherwise fall back to the homestay base price. Mirrors bookings.js.
function resolveUnitPrice(booking, homestay) {
  let unitPrice = Number(homestay.ownerPrice);
  if (booking && booking.roomId && Array.isArray(homestay.rooms)) {
    const room = homestay.rooms.find(r => String(r.id) === String(booking.roomId));
    if (room && Number.isFinite(Number(room.price))) {
      unitPrice = Number(room.price);
    }
  }
  return unitPrice;
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
// CANCELLATION EMAIL
//
// One email per outcome. Which one is decided by the tier, not by
// guessing at the status string. Tier C is its own case: nothing is
// due, and the guest must be told that plainly rather than being told
// a refund failed.
// ============================================================

async function sendCancellationEmail(booking, refundInfo, env) {
  if (!booking || !booking.guestEmail) {
    return { sent: false, error: 'No guest email on file' };
  }

  const e = escHtml;
  const isGuestRequest = String(refundInfo.cancelType || '') === 'guest_request';
  const tier = refundInfo.tier || null;

  const totalPaidNum = Number(booking.amount_paid || booking.total || 0);
  const baseNum = Number(booking.base || 0);
  const refundAmountNum = Number(refundInfo.refundAmount || 0);
  const hostAmountNum = Number(refundInfo.hostAmount || 0);

  const totalPaid = totalPaidNum.toFixed(2);
  const baseStr = baseNum.toFixed(2);
  const refundAmount = refundAmountNum.toFixed(2);
  const hostAmount = hostAmountNum.toFixed(2);

  const initiatedBy = isGuestRequest
    ? 'at your request, with your host\'s agreement'
    : 'by your host';

  let subject, headerColor, headerText, bodyHtml;

    if (refundInfo.noRefundDue && !isGuestRequest) {
    // A host cancellation where nothing was ever charged. The Tier C
    // wording below tells the guest *they* cancelled — they did not.
    subject = 'Booking Cancelled by Host';
    headerColor = '#6b7280';
    headerText = 'Booking Cancelled';
    bodyHtml = `
      <p>Your booking at <strong>${e(booking.homestay)}</strong> has been cancelled by your host.</p>
      <p>Nothing had been charged to you for this booking, so there is nothing to refund.</p>
    `;
  } else if (refundInfo.noRefundDue) {
    subject = 'Booking Cancelled — Nothing To Refund';
    headerColor = '#6b7280';
    headerText = 'Booking Cancelled';
    bodyHtml = `
      <p>Your booking at <strong>${e(booking.homestay)}</strong> has been cancelled ${initiatedBy}.</p>
      <p>Because you cancelled less than 48 hours before check-in, <strong>no refund is due</strong> under our published policy. The room was held for you and could not be resold.</p>
      <p>Your host was paid the room price of <strong>RM${e(baseStr)}</strong> for holding it. That is the same outcome as a no-show.</p>
      <p>If you believe this is wrong, email <a href="mailto:support@kundasanghomestay.my">support@kundasanghomestay.my</a> and we will review it.</p>
    `;
  } else if (refundInfo.isPaid && refundInfo.refundSuccess && !refundInfo.refundPending) {
    subject = isGuestRequest
      ? 'Booking Cancelled at Your Request — Refund Processed'
      : 'Booking Cancelled by Host — Refund Processed';
    headerColor = '#16a34a';
    headerText = '✓ Booking Cancelled — Refund Processed';

    const tierNote = !isGuestRequest
      ? `<p>Your host cancelled this booking, so you receive <strong>everything you paid</strong> — the room, the service fee and the RM 1.00 payment fee. Nothing is held back.</p>`
      : (tier === 'A'
          ? `<p>You cancelled with 14 days or more notice, so you receive <strong>everything you paid, less the RM 1.00 refund-processing fee</strong>.</p>`
          : (tier === 'B'
              ? `<p>You cancelled between 48 hours and 13 days before check-in, so you receive <strong>half the room price</strong>. The other half is paid to your host, whose room could not be resold at short notice.</p>`
              : `<p>A refund of <strong>RM${e(refundAmount)}</strong> has been processed to your original payment method via CHIP.</p>`));

    const detailRows = !isGuestRequest
      ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">You paid</td><td style="padding:4px 0;font-weight:600;">RM ${e(totalPaid)}</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Held back for cancelling</td><td style="padding:4px 0;font-weight:600;">None — your host cancelled</td></tr>`
      : (tier === 'A'
          ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">You paid</td><td style="padding:4px 0;font-weight:600;">RM ${e(totalPaid)}</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Less: refund-processing fee</td><td style="padding:4px 0;font-weight:600;">− RM 1.00</td></tr>`
          : `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">You paid</td><td style="padding:4px 0;font-weight:600;">RM ${e(totalPaid)}</td></tr>
         <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Room price</td><td style="padding:4px 0;font-weight:600;">RM ${e(baseStr)}</td></tr>`);

    bodyHtml = `
      <p>Your booking at <strong>${e(booking.homestay)}</strong> has been cancelled ${initiatedBy}.</p>
      ${tierNote}
      <table style="font-size:13px;margin:12px 0;">
        ${detailRows}
        <tr style="border-top:1px solid #e5e7eb;"><td style="padding:6px 12px 4px 0;color:#0F382E;font-weight:700;">Refunded to you</td><td style="padding:6px 0;color:#0F382E;font-weight:800;">RM ${e(refundAmount)}</td></tr>
        ${hostAmountNum > 0 ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Paid to your host</td><td style="padding:4px 0;font-weight:600;">RM ${e(hostAmount)}</td></tr>` : ''}
      </table>
      <p>Refunds typically take <strong>1–7 business days</strong> to appear in your bank account, depending on your bank's processing times.</p>
      <p><strong>Refund reference (CHIP):</strong> ${e(refundInfo.refundId || 'N/A')}</p>
    `;
  } else if (refundInfo.isPaid && refundInfo.refundSuccess && refundInfo.refundPending) {
    subject = 'Booking Cancelled — Refund Processing';
    headerColor = '#d97706';
    headerText = '⏳ Booking Cancelled — Refund Processing';
    bodyHtml = `
      <p>Your booking at <strong>${e(booking.homestay)}</strong> has been cancelled ${initiatedBy}.</p>
      <p>A refund of <strong>RM${e(refundAmount)}</strong> is being processed by CHIP. This usually completes within a few minutes.</p>
      <p>Once CHIP finishes, the refund may take a further <strong>1–7 business days</strong> to appear in your bank account.</p>
      <p><strong>Refund reference (CHIP):</strong> ${e(refundInfo.refundId || 'N/A')}</p>
    `;
  } else if (refundInfo.isPaid && !refundInfo.refundSuccess) {
    subject = 'Booking Cancelled';
    headerColor = '#dc2626';
    headerText = '❌ Booking Cancelled — Refund Pending Review';
    bodyHtml = `
      <p>Your booking at <strong>${e(booking.homestay)}</strong> has been cancelled ${initiatedBy}.</p>
      <p>Your payment of <strong>RM${e(totalPaid)}</strong> was taken. The refund could not be processed automatically and is now under manual review by our team.</p>
      <p>Please contact <a href="mailto:support@kundasanghomestay.my">support@kundasanghomestay.my</a> if you don't hear from us within 24 hours.</p>
    `;
  } else {
    subject = 'Booking Cancelled';
    headerColor = '#6b7280';
    headerText = '❌ Booking Cancelled';
    bodyHtml = `
      <p>Your booking at <strong>${e(booking.homestay)}</strong> has been cancelled ${initiatedBy}.</p>
      <p>No payment was taken for this booking, so no refund is needed.</p>
    `;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:${headerColor};">${headerText}</h2>
      <p>Hello ${e(booking.guestName) || 'Guest'},</p>
      ${bodyHtml}
      <div style="background:#f8f5f0;padding:16px;border-radius:8px;margin:16px 0;font-size:13px;">
        <div><strong>Booking ID:</strong> ${e(booking.id)}</div>
        <div><strong>Homestay:</strong> ${e(booking.homestay)}</div>
        <div><strong>Check-in:</strong> ${e(booking.checkin)}</div>
        <div><strong>Check-out:</strong> ${e(booking.checkout)}</div>
        <div><strong>Nights:</strong> ${e(booking.nights)}</div>
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
  } catch (err) {
    return { sent: false, error: err.message };
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

    let body;
    try {
      body = await parseJSONSafely(request);
    } catch (err) {
      return jsonResponse({ error: 'Invalid request body' }, 400, request);
    }

    const { bookingId, checkin, checkout, action } = body;

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const ownerHomestayIds = await getOwnerHomestayIdsFresh(db, ownerData);

    // ===== ACTION: Update room block =====
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

    // ===== ACTION: Update homestay price =====
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

     // ===== ACTION: Add room =====
    if (action === 'addRoom') {
      const { homestayId, room } = body;
      if (!homestayId || !room || typeof room !== 'object') {
        return jsonResponse({ error: 'Missing homestayId or room data' }, 400, request);
      }

      if (!ownerHomestayIds.map(String).includes(String(homestayId))) {
        return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
      }

      const cleanName = String(room.name || '').trim().slice(0, 100);
      if (!cleanName) return jsonResponse({ error: 'Room name is required' }, 400, request);

      const cleanPrice = Number(room.price);
      if (!Number.isFinite(cleanPrice) || cleanPrice <= 0 || cleanPrice > 100000) {
        return jsonResponse({ error: 'Room price must be a positive number' }, 400, request);
      }

      const cleanGuests = (room.guests !== undefined && room.guests !== null && room.guests !== '')
        ? Math.max(1, Math.min(50, parseInt(room.guests, 10) || 1))
        : null;

      const cleanDesc = String(room.desc || '').slice(0, 500);

      const cleanImages = Array.isArray(room.images)
        ? room.images.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 10)
        : [];
      const cleanPublicIds = Array.isArray(room.imagePublicIds)
        ? room.imagePublicIds.filter(u => typeof u === 'string').slice(0, 10)
        : [];

      const newRoom = {
        id: 'room-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        name: cleanName,
        price: cleanPrice,
        guests: cleanGuests,
        desc: cleanDesc,
        images: cleanImages,
        imagePublicIds: cleanPublicIds,
        blockedDates: []
      };

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
              if (!Array.isArray(arr[index].rooms)) arr[index].rooms = [];
              arr[index].rooms.push(newRoom);
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
        action: 'room_added',
        admin: 'owner',
        details: `Room "${newRoom.name}" (RM ${newRoom.price}) added to homestay ${homestayId}`,
        ip: clientIP,
        userId: ownerData.ownerId,
        homestayId: homestayId
      });

      return jsonResponse({ success: true, message: `Room "${newRoom.name}" added.`, room: newRoom }, 200, request);
    }

    // ===== ACTION: Update room =====
    if (action === 'updateRoom') {
      const { homestayId, roomId, room } = body;
      if (!homestayId || !roomId || !room || typeof room !== 'object') {
        return jsonResponse({ error: 'Missing homestayId, roomId, or room data' }, 400, request);
      }

      if (!ownerHomestayIds.map(String).includes(String(homestayId))) {
        return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
      }

      const patch = {};
      if (room.name !== undefined) {
        const cleanName = String(room.name || '').trim().slice(0, 100);
        if (!cleanName) return jsonResponse({ error: 'Room name cannot be empty' }, 400, request);
        patch.name = cleanName;
      }
      if (room.price !== undefined) {
        const cleanPrice = Number(room.price);
        if (!Number.isFinite(cleanPrice) || cleanPrice <= 0 || cleanPrice > 100000) {
          return jsonResponse({ error: 'Room price must be a positive number' }, 400, request);
        }
        patch.price = cleanPrice;
      }
      if (room.guests !== undefined) {
        patch.guests = (room.guests === null || room.guests === '')
          ? null
          : Math.max(1, Math.min(50, parseInt(room.guests, 10) || 1));
      }
      if (room.desc !== undefined) {
        patch.desc = String(room.desc || '').slice(0, 500);
      }
      if (room.images !== undefined) {
        patch.images = Array.isArray(room.images)
          ? room.images.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 10)
          : [];
      }
      if (room.imagePublicIds !== undefined) {
        patch.imagePublicIds = Array.isArray(room.imagePublicIds)
          ? room.imagePublicIds.filter(u => typeof u === 'string').slice(0, 10)
          : [];
      }

      if (Object.keys(patch).length === 0) {
        return jsonResponse({ error: 'No fields to update' }, 400, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          let updated = false;
          let updatedRoom = null;
          for (const key of ['kd_approved', 'kd_pending']) {
            const res = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
            let arr = [];
            if (res && res.data) { try { arr = JSON.parse(res.data); } catch (e) {} }
            const index = arr.findIndex(h => String(h.id) === String(homestayId));
            if (index !== -1) {
              if (!Array.isArray(arr[index].rooms)) arr[index].rooms = [];
              const rIdx = arr[index].rooms.findIndex(r => String(r.id) === String(roomId));
              if (rIdx === -1) continue;
              arr[index].rooms[rIdx] = { ...arr[index].rooms[rIdx], ...patch };
              updatedRoom = arr[index].rooms[rIdx];
              await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
                .bind(key, JSON.stringify(arr))
                .run();
              updated = true;
            }
          }
          if (!updated || !updatedRoom) return { error: 'Room not found', status: 404 };
          return { success: true, room: updatedRoom };
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
        action: 'room_updated',
        admin: 'owner',
        details: `Room "${result.room.name}" updated on homestay ${homestayId}`,
        ip: clientIP,
        userId: ownerData.ownerId,
        homestayId: homestayId
      });

      return jsonResponse({ success: true, message: `Room "${result.room.name}" updated.`, room: result.room }, 200, request);
    }

    // ===== ACTION: Delete room =====
    if (action === 'deleteRoom') {
      const { homestayId, roomId } = body;
      if (!homestayId || !roomId) {
        return jsonResponse({ error: 'Missing homestayId or roomId' }, 400, request);
      }

      if (!ownerHomestayIds.map(String).includes(String(homestayId))) {
        return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
      }

      // Refuse if any live (paid / completed) booking exists on this
      // room. Dead statuses and 15-minute payment holds don't block.
      const bookingsRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      let allBookings = [];
      try { if (bookingsRes?.data) allBookings = JSON.parse(bookingsRes.data); } catch (_) {}

      const activeBookings = allBookings.filter(b => {
        if (String(b.roomId) !== String(roomId)) return false;
        const s = String(b.status || '');
        if (/cancelled|failed|expired|refunded|refund pending|pending payment/i.test(s)) return false;
        return true;
      });

      if (activeBookings.length > 0) {
        return jsonResponse({
          error: `This room has ${activeBookings.length} active booking${activeBookings.length === 1 ? '' : 's'} (paid or completed). Please cancel or complete ${activeBookings.length === 1 ? 'it' : 'them'} before deleting this room.`
        }, 400, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          let updated = false;
          let removedRoom = null;
          for (const key of ['kd_approved', 'kd_pending']) {
            const res = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
            let arr = [];
            if (res && res.data) { try { arr = JSON.parse(res.data); } catch (e) {} }
            const index = arr.findIndex(h => String(h.id) === String(homestayId));
            if (index !== -1) {
              if (!Array.isArray(arr[index].rooms)) arr[index].rooms = [];
              const rIdx = arr[index].rooms.findIndex(r => String(r.id) === String(roomId));
              if (rIdx === -1) continue;
              removedRoom = arr[index].rooms[rIdx];
              arr[index].rooms.splice(rIdx, 1);
              await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
                .bind(key, JSON.stringify(arr))
                .run();
              updated = true;
            }
          }
          if (!updated) return { error: 'Room not found', status: 404 };
          return { success: true, removed: removedRoom };
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
        action: 'room_deleted',
        admin: 'owner',
        details: `Room "${result.removed?.name || roomId}" removed from homestay ${homestayId}`,
        ip: clientIP,
        userId: ownerData.ownerId,
        homestayId: homestayId
      });

      return jsonResponse({ success: true, message: 'Room removed.', removed: result.removed }, 200, request);
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
            const unitPrice = resolveUnitPrice(booking, homestay);
            const price = calculatePrice(unitPrice, nights);
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

    // ========== ACTION: DECLINE A CANCELLATION REQUEST ==========
    //
    // The host says no. Nothing is cancelled and no money moves — we just
    // record the decision and the reason. The guest can ask us to review it.
    if (action === 'declineCancellation') {
      const declineReason = String(body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (declineReason.length < 10) {
        return jsonResponse({
          error: 'Please give a reason for declining — at least 10 characters. The guest sees this, and so do we if they ask us to review it.'
        }, 400, request);
      }

      const preRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      let preBookings = [];
      try { if (preRes?.data) preBookings = JSON.parse(preRes.data); } catch (_) {}
      const preBooking = preBookings.find(b => String(b.id) === String(bookingId));
      if (!preBooking) return jsonResponse({ error: 'Invalid request.' }, 400, request);

      if (!ownerHomestayIds.map(String).includes(String(preBooking.homestayId))) {
        return jsonResponse({ error: 'Unauthorized: You do not own this homestay' }, 403, request);
      }

      let declined;
      try {
        declined = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          let bookings = [];
          try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
          const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
          if (idx === -1) return { error: 'Booking not found', status: 404 };

          const b = bookings[idx];
          const req = b.cancellationRequest;
          if (!req || req.status !== 'pending_host') {
            return { error: 'There is no cancellation request waiting on this booking.', status: 400 };
          }

          const nowIso = new Date().toISOString();
          bookings[idx] = {
            ...b,
            cancellationRequest: {
              ...req,
              status: 'declined',
              declinedAt: nowIso,
              declinedBy: 'owner',
              declineReason,
              history: [
                ...(Array.isArray(req.history) ? req.history : []),
                { at: nowIso, event: 'declined', note: declineReason }
              ].slice(-20)
            },
            statusUpdated: nowIso
          };

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          return { success: true, booking: bookings[idx] };
        }, 60000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another booking operation is in progress. Please wait a moment and try again.' }, 429, request);
        }
        throw lockErr;
      }

      if (declined.error) return jsonResponse({ error: declined.error }, declined.status || 400, request);

      await logAction({
        db,
        action: 'cancellation_request_declined',
        admin: 'owner',
        details: `Host declined cancellation request on ${bookingId}. Reason: ${declineReason}`,
        ip: clientIP,
        userId: declined.booking.guestEmail,
        homestayId: declined.booking.homestayId
      });

      return jsonResponse({
        success: true,
        message: 'You declined the request. The booking stands, and the guest has been told why.'
      }, 200, request);
    }

    // ========== ACTION: CANCEL BOOKING / ACCEPT A CANCELLATION REQUEST ==========
    //
    // Two ways in, one money path:
    //   acceptCancellation — host accepts a request the guest made through
    //                        the form, so we have their original date.
    //   cancelBooking      — host cancels for their own reasons, or accepts
    //                        a request the guest made off-platform.
    //
    // Refund amounts come from computeCancellationTier() in _utils.js.
    if (action === 'cancelBooking' || action === 'acceptCancellation') {
      const cancelTypeRaw = action === 'acceptCancellation'
        ? 'guest_request'
        : String(body.cancelType || 'host_own').toLowerCase().trim();
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
          const existingRequest = booking.cancellationRequest;

          // Accepting a recorded request: it must still be waiting.
          if (action === 'acceptCancellation') {
            if (!existingRequest || existingRequest.status !== 'pending_host') {
              return { error: 'There is no cancellation request waiting on this booking.', status: 400 };
            }
          }

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

          const totalPaidNum = Number(booking.amount_paid || booking.total) || 0;
          const baseAmountNum = Number(booking.base) || 0;

          // ---- How much notice did the guest give? ----
          //
          // If they used the form, requestedAt is their real date and the
          // tier is fixed by it. If they only asked you on WhatsApp, there
          // is no recorded date, so we measure from now. We cannot
          // back-date a refund on someone's say-so.
          const recordedAtMs = existingRequest && existingRequest.requestedAt
            ? Date.parse(existingRequest.requestedAt)
            : NaN;
          const hasRecordedDate = Number.isFinite(recordedAtMs);
          const askedAtMs = hasRecordedDate ? recordedAtMs : Date.now();

          const tierInfo = computeCancellationTier(booking, askedAtMs);

          // ---- Safety guard ----
          // If the tier maths could not work out the dates, we must not
          // guess. Accepting would refund nothing to the guest AND pay
          // nothing to the host, silently. Refuse and ask a human to look.
          if (cancelType === 'guest_request' && tierInfo.needsReview) {
            return {
              error: 'We could not work out the refund for this booking — the check-in date or the request date is unclear. Please contact support@kundasanghomestay.my before cancelling.',
              status: 400
            };
          }

          // ---- Is this even a tier case? ----
          //
          // Tiers describe how much notice the GUEST gave. When the host
          // cancels for their own reasons there is no notice period to
          // measure, and the guest gets everything back whatever the date,
          // so no tier applies. Stamping one on would mislabel the refund
          // in the booking record, in both ledgers, and in every report
          // that reads them.
          const cancellationTier = cancelType === 'guest_request'
            ? (tierInfo.tier || null)
            : null;

          const refundAmountNum = cancelType === 'guest_request'
            ? tierInfo.guestAmount
            : totalPaidNum;

          const hostCompensationNum = cancelType === 'guest_request'
            ? tierInfo.hostAmount
            : 0;

          // Tier C returns nothing to the guest. There is no refund to
          // make, so a missing refund must not be treated as a failure.
          const noRefundDue = isPaid && refundAmountNum <= 0;

          const platformKeptNum = cancelType === 'guest_request'
            ? tierInfo.platformKeeps
            : Math.max(0, Math.round((totalPaidNum - refundAmountNum) * 100) / 100);

          let refundSuccess = false;
          let refundData = null;
          let refundError = null;

          if (isPaid && booking.chip_purchase_id && refundAmountNum > 0) {
            // Set the attempt marker BEFORE the CHIP call. If the call
            // succeeds, chip_refund_id will be set. If it fails (network
            // or API), the marker blocks a blind retry that could
            // double-refund.
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

          const cancelledLabel = cancelType === 'guest_request'
            ? 'Cancelled at Guest Request'
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
            bookings[idx].cancellation_tier = cancellationTier;
            bookings[idx].statusUpdated = new Date().toISOString();
            if (isPending) bookings[idx].refund_pending = true;
          } else if (isPaid && noRefundDue) {
            bookings[idx].status = 'Cancelled - Nothing Due';
            bookings[idx].refund_amount = 0;
            bookings[idx].cancelled_by = 'host';
            bookings[idx].cancel_type = cancelType;
            bookings[idx].cancellation_tier = cancellationTier;
            bookings[idx].statusUpdated = new Date().toISOString();
          } else if (isPaid && !refundSuccess) {
            bookings[idx].status = 'Cancelled by Host - Refund Pending';
            bookings[idx].refund_error = refundError || 'Unknown error';
            bookings[idx].cancelled_by = 'host';
            bookings[idx].cancel_type = cancelType;
            bookings[idx].cancellation_tier = cancellationTier;
            bookings[idx].statusUpdated = new Date().toISOString();
          } else {
            bookings[idx].status = cancelledLabel;
            bookings[idx].cancelled_by = 'host';
            bookings[idx].cancel_type = cancelType;
            bookings[idx].statusUpdated = new Date().toISOString();
          }

          // ---- Record the decision on the request itself ----
          if (action === 'acceptCancellation' && existingRequest) {
            const nowIso = new Date().toISOString();
            bookings[idx].cancellationRequest = {
              ...existingRequest,
              status: 'accepted',
              acceptedAt: nowIso,
              acceptedBy: 'owner',
              acceptedTier: tierInfo.tier,
              refundAmount: refundAmountNum,
              hostCompensation: hostCompensationNum,
              history: [
                ...(Array.isArray(existingRequest.history) ? existingRequest.history : []),
                { at: nowIso, event: 'accepted', note: `Tier ${tierInfo.tier || '?'}` }
              ].slice(-20)
            };
          }

          // ---- Queue the host's own share on Tiers B and C ----
          //
          // The guest paid in full, and the money never reached the host
          // because there was no check-in. The policy still pays them, so
          // it goes into the same manual payout queue normal payouts use.
          if (hostCompensationNum > 0) {
            const nowIso = new Date().toISOString();

            let homestayForQueue = null;
            for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
              const hr = await db.prepare('SELECT data FROM store WHERE key = ?').bind(store).first();
              let list = [];
              try { if (hr?.data) list = JSON.parse(hr.data); } catch (_) {}
              const found = list.find(h => String(h.id) === String(booking.homestayId));
              if (found) { homestayForQueue = found; break; }
            }

            bookings[idx].manualPayoutPending = true;
            bookings[idx].manualPayoutAmount = hostCompensationNum;
            bookings[idx].manualPayoutQueuedAt = nowIso;
            bookings[idx].manualPayoutKind = 'cancellation';
            bookings[idx].manualPayoutReason = tierInfo.tier === 'B'
              ? 'Cancellation compensation — Tier B (half the room price)'
              : 'Cancellation compensation — Tier C (full room price)';
            bookings[idx].manualPayoutHostName = homestayForQueue?.ownerName || '';
            bookings[idx].manualPayoutHostEmail = homestayForQueue?.ownerEmail || '';
            bookings[idx].manualPayoutHostWhatsapp = homestayForQueue?.whatsapp || '';
            bookings[idx].manualPayoutBankName = homestayForQueue?.ownerBank || '';
            bookings[idx].manualPayoutBankCode = homestayForQueue?.bankCode || '';
            bookings[idx].manualPayoutAccountNumber = homestayForQueue?.ownerBankAccount || '';
            bookings[idx].manualPayoutAccountHolder = homestayForQueue?.bankHolder || '';
            bookings[idx].manualPayoutHomestayName = homestayForQueue?.name || booking.homestay || '';
          }

          // ---- Ledgers ----
          let feeEarningsToWrite = null;
          let feeRecordedAmount = 0;
          let chipCostsToWrite = null;
          let chipCostRecorded = 0;

          if (isPaid && (refundSuccess || noRefundDue)) {
            try {
              const feeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
              let feeEarnings = feeRes && feeRes.data
                ? JSON.parse(feeRes.data)
                : { total: 0, available: 0, withdrawn: 0, history: [] };
              feeEarnings.history = feeEarnings.history || [];

              const alreadyRecorded = feeEarnings.history.some(h =>
                h.bookingId === bookingId &&
                (h.type === 'earning' || h.type === 'cancellation_retained_fee')
              );

              if (!alreadyRecorded && platformKeptNum > 0) {
                feeEarnings.total = Math.round(((feeEarnings.total || 0) + platformKeptNum) * 100) / 100;
                feeEarnings.available = Math.round(((feeEarnings.available || 0) + platformKeptNum) * 100) / 100;
                feeEarnings.history.push({
                  bookingId,
                  fee: platformKeptNum,
                  date: new Date().toISOString(),
                  type: 'cancellation_retained_fee',
                  cancellation_type: cancelType,
                  cancellation_tier: cancellationTier,
                  original_amount_paid: totalPaidNum,
                  refunded_amount: refundAmountNum,
                  paid_to_host: hostCompensationNum,
                  method: 'chip_collect_partial_refund',
                  ip: clientIP
                });
                feeEarningsToWrite = feeEarnings;
                feeRecordedAmount = platformKeptNum;
              }
            } catch (feeReadErr) {
              console.error('Could not read fee earnings before cancel batch:', feeReadErr.message);
            }

            try {
              const chipRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_chip_costs').first();
              let chipCosts = chipRes && chipRes.data
                ? JSON.parse(chipRes.data)
                : { total: 0, history: [] };
              chipCosts.history = chipCosts.history || [];

              const alreadyRecordedChip = chipCosts.history.some(h =>
                h.bookingId === bookingId && h.type === 'cancellation'
              );

              // A refund costs a second CHIP fee. Tier C has no refund,
              // so only the payment fee applies.
              const chipCostAmount = refundSuccess
                ? CHIP_TOTAL_FEES_PER_CANCELLATION
                : CHIP_PAYMENT_FEE;

              if (!alreadyRecordedChip && chipCostAmount > 0) {
                chipCosts.total = Math.round(((chipCosts.total || 0) + chipCostAmount) * 100) / 100;
                chipCosts.history.push({
                  bookingId,
                  amount: chipCostAmount,
                  payment_fee: CHIP_PAYMENT_FEE,
                  refund_fee: refundSuccess ? CHIP_REFUND_FEE : 0,
                  date: new Date().toISOString(),
                  type: 'cancellation',
                  cancellation_type: cancelType,
                  cancellation_tier: cancellationTier,
                  ip: clientIP
                });
                chipCostsToWrite = chipCosts;
                chipCostRecorded = chipCostAmount;
              }
            } catch (chipReadErr) {
              console.error('Could not read chip costs before cancel batch:', chipReadErr.message);
            }
          }

          const atomicStmts = [
            db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_bookings', JSON.stringify(bookings))
          ];
          if (feeEarningsToWrite) {
            atomicStmts.push(
              db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
                .bind('kd_fee_earnings', JSON.stringify(feeEarningsToWrite))
            );
          }
          if (chipCostsToWrite) {
            atomicStmts.push(
              db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
                .bind('kd_chip_costs', JSON.stringify(chipCostsToWrite))
            );
          }

          try {
            await db.batch(atomicStmts);
          } catch (batchErr) {
            console.error('Atomic batch write failed during cancel:', batchErr.message);
            return {
              error: `Refund succeeded at CHIP but the booking and ledgers could not be updated (${batchErr.message}). Booking left in "attempt marker only" state. Verify refund ${refundData?.id || ''} in the CHIP dashboard, then contact support to reconcile.`,
              status: 500
            };
          }

          return {
            success: true,
            isPaid,
            cancelType,
            tier: cancellationTier,
            usedRecordedDate: hasRecordedDate,
            refundAmountNum,
            hostCompensationNum,
            platformKeptNum,
            feeRecordedAmount,
            chipCostRecorded,
            refundSuccess,
            refundData,
            refundError,
            noRefundDue,
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

      let emailReport = { sent: false, error: 'skipped' };
      try {
        emailReport = await sendCancellationEmail(result.booking, {
          isPaid: result.isPaid,
          cancelType: result.cancelType,
          tier: result.tier,
          refundAmount: result.refundAmountNum,
          hostAmount: result.hostCompensationNum,
          noRefundDue: result.noRefundDue,
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
          ? (result.noRefundDue
              ? 'booking_cancelled_no_refund_due'
              : (result.refundSuccess
                  ? (result.refundPending ? 'booking_cancelled_refund_pending' : 'booking_cancelled_refund_success')
                  : 'booking_cancelled_refund_failed'))
          : 'booking_cancelled_unpaid',
        admin: 'owner',
        details: `Booking ${bookingId} cancelled by host ${ownerData.whatsapp} — type=${result.cancelType}, tier=${result.tier || 'n/a'}${result.cancelType === 'guest_request' ? (result.usedRecordedDate ? " (guest's recorded date)" : ' (no recorded date — measured from now)') : ''}. Guest refund: ${
          result.noRefundDue ? 'none due'
          : (result.refundSuccess
              ? (result.refundPending ? `pending, ${result.refundData.id}, RM${result.refundAmountNum.toFixed(2)}` : `sent, ${result.refundData.id}, RM${result.refundAmountNum.toFixed(2)}`)
              : `FAILED — ${result.refundError}`)
        }. Host compensation queued: RM${result.hostCompensationNum.toFixed(2)}. Platform kept: RM${result.platformKeptNum.toFixed(2)}. Chip cost recorded: RM${result.chipCostRecorded.toFixed(2)}. Email: ${emailReport.sent ? 'sent' : 'failed — ' + (emailReport.error || 'unknown')}`,
        ip: clientIP,
        userId: result.booking.guestEmail,
        homestayId: result.booking.homestayId
      });

      const refundMsg = (() => {
        if (!result.isPaid) {
          return `Booking ${bookingId} cancelled (unpaid).`;
        }
        // A host-initiated cancellation has no tier. Say what actually
        // happened rather than naming a tier that does not apply.
        if (result.cancelType === 'host_own') {
          if (result.noRefundDue) {
            return `Booking ${bookingId} cancelled by you. Nothing was charged to the guest, so there is nothing to refund.`;
          }
          const amt = Number(result.refundAmountNum).toFixed(2);
          if (result.refundSuccess) {
            return result.refundPending
              ? `Booking ${bookingId} cancelled by you. CHIP is processing the full refund of RM${amt} to the guest — this can take a few minutes. As you cancelled, no payout is due to you.`
              : `Booking ${bookingId} cancelled by you. Full refund of RM${amt} to the guest processed. As you cancelled, no payout is due to you.`;
          }
          return `Booking ${bookingId} cancelled but the refund failed. Status set to 'Refund Pending'. Please contact support.`;
        }
        if (result.noRefundDue) {
          return `Booking ${bookingId} cancelled at Tier ${result.tier}. No refund is due to the guest — the room was held right up to check-in. The host's RM${result.hostCompensationNum.toFixed(2)} has been added to the payout queue.`;
        }
        if (result.refundSuccess) {
          const amt = Number(result.refundAmountNum).toFixed(2);
          const hostLine = result.hostCompensationNum > 0
            ? ` RM${result.hostCompensationNum.toFixed(2)} has been added to the payout queue for you.`
            : '';
          if (result.refundPending) {
            return `Booking ${bookingId} cancelled at Tier ${result.tier}. CHIP is processing the RM${amt} refund — this can take a few minutes.${hostLine}`;
          }
          return `Booking ${bookingId} cancelled at Tier ${result.tier}. Refund of RM${amt} processed.${hostLine}`;
        }
        return `Booking ${bookingId} cancelled but the refund failed. Status set to 'Refund Pending'. Please contact support.`;
      })();

      return jsonResponse({
        success: true,
        message: refundMsg,
        cancelType: result.cancelType,
        tier: result.tier,
        refundAmount: result.refundAmountNum,
        hostCompensation: result.hostCompensationNum,
        platformKept: result.platformKeptNum,
        noRefundDue: result.noRefundDue,
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

export async function onRequestOptions({ request, env }) {
  return new Response(null, { headers: corsHeaders(request) });
}
