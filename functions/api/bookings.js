// /api/bookings.js — Plain English: this file handles all booking reads
// and writes. Two things changed in THIS revision inside
// createPublicBooking():
//   (1) If the SAME guest books the SAME dates at the SAME homestay
//       again, and they already have a "Pending Payment" or
//       "Payment Failed" booking for those dates, we REUSE that
//       existing booking instead of creating a duplicate.
//   (2) Stale "Payment Failed" bookings now also get expired the same
//       way stale "Pending Payment" ones do (after 15 minutes).
// Everything else (locking, admin actions, pagination, CSP, auth) is
// unchanged from the previous version.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  validateCSRFToken,
  getCSRFToken,
  getGuestSession,
  verifyAdminAuth,
  jsonResponse,
  parseJSONSafely,
  withLock,
  checkRateLimit,
  recordRateLimit,
  invalidateOwnerSessionsForHomestay
} from './_utils.js';

const MAX_NIGHTS = 60;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_APPROVED_PAGE_SIZE = 100;
const DEFAULT_PENDING_PAGE_SIZE = 100;
const GATEWAY_FEE = 1.00;
const PENDING_EXPIRY_MS = 15 * 60 * 1000;

const BOOKINGS_LOCK = 'bookings-global';

// ============================================================
// Field whitelists
// ============================================================

const PUBLIC_HOMESTAY_FIELDS = [
  'id', 'name', 'location', 'description',
  'ownerName', 'whatsapp',
  'ownerPrice', 'guests', 'bedrooms',
  'image', 'images', 'rooms',
  'blockedDates', 'approved', 'verified',
  'rating', 'reviews', 'createdAt', 'updatedAt'
];

const ADMIN_STATUS_FIELD_WHITELIST = ['status', 'statusUpdated'];

function pickPublicFields(h) {
  if (!h || typeof h !== 'object') return h;
  const out = {};
  for (const k of PUBLIC_HOMESTAY_FIELDS) {
    if (h[k] !== undefined) out[k] = h[k];
  }
  return out;
}

function stripPasswordFields(h) {
  if (!h || typeof h !== 'object') return h;
  const {
    ownerPasswordHash,
    ownerSalt,
    ownerPasswordAlgorithm,
    ownerPasswordVersion,
    ...safe
  } = h;
  return safe;
}

// ============================================================
// Helpers
// ============================================================

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

function isDeadBookingStatus(status) {
  return /cancelled|failed|expired|refunded/i.test(String(status || ''));
}

async function verifyAdmin(request, env) {
  const ok = await verifyAdminAuth(request, env);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: corsHeaders(request)
    });
  }
  return null;
}

async function requireGuest(request, env, body) {
  const session = await getGuestSession(request, env);
  if (!session || session.type !== 'guest') {
    return { error: jsonResponse({ error: 'Authentication required' }, 401, request) };
  }
  const guestId = body?.booking?.guestId || body?.guestId;
  if (guestId && String(guestId) !== String(session.userId)) {
    return { error: jsonResponse({ error: 'Guest identity mismatch' }, 403, request) };
  }
  const csrf = getCSRFToken(request);
  if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) {
    return { error: jsonResponse({ error: 'Invalid security token' }, 403, request) };
  }
  return { session };
}

// ============================================================
// Rejection notification email
// ============================================================
async function sendRejectionEmail(homestay, reason, env) {
  if (!homestay.ownerEmail) {
    return { sent: false, error: 'No email address on file' };
  }
  const safe = (s) => String(s || '').replace(/[<>]/g, '');
  const reasonHtml = reason
    ? `<p><strong>Reason provided:</strong></p>
       <p style="background:#fef3c7;padding:12px;border-radius:8px;border:1px solid #fde68a;">${safe(reason)}</p>`
    : `<p>If you have any questions, please contact support.</p>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#0F382E;">Hello ${safe(homestay.ownerName || 'Host')},</h2>
      <p>Thank you for submitting your homestay "<strong>${safe(homestay.name)}</strong>" to Kundasang Homestay.</p>
      <p>After reviewing your listing, we are unable to approve it at this time.</p>
      ${reasonHtml}
      <p>You are welcome to submit a new listing with the required corrections. If you believe this was a mistake, please contact <a href="mailto:support@kundasanghomestay.my">support@kundasanghomestay.my</a>.</p>
      <p>— Kundasang Homestay Team</p>
    </div>
  `;

  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: homestay.ownerEmail,
          subject: 'Update on Your Homestay Listing — Kundasang Homestay',
          html
        })
      });
      return { sent: r.ok, error: r.ok ? null : 'Resend API error' };
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: homestay.ownerEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Update on Your Homestay Listing — Kundasang Homestay',
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

// ============================================================
// GET
// ============================================================
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const guestSession = await getGuestSession(request, env);
    const isAdmin = await verifyAdminAuth(request, env);

    const keys = ['kd_bookings', 'kd_approved', 'kd_pending', 'kd_guests',
                  'kd_demo_overrides', 'kd_demo_blocked', 'kd_deleted_demo'];
    const stmts = keys.map(key => db.prepare('SELECT data FROM store WHERE key = ?').bind(key));
    const results = await db.batch(stmts);

    const dataMap = {};
    keys.forEach((key, index) => {
      const row = results[index]?.results?.[0];
      try { dataMap[key] = row?.data ? JSON.parse(row.data) : []; } catch (_) { dataMap[key] = []; }
    });

    const bookings = dataMap['kd_bookings'];
    const approved = dataMap['kd_approved'];
    const pending = dataMap['kd_pending'];
    const guests = dataMap['kd_guests'];
    const demoOverrides = dataMap['kd_demo_overrides'];
    const demoBlocked = dataMap['kd_demo_blocked'];
    const deletedDemo = dataMap['kd_deleted_demo'];

    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const limit = parseInt(url.searchParams.get('limit')) || DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * limit;

    // ============ ADMIN BRANCH ============
    if (isAdmin) {
      const paginated = bookings.slice(offset, offset + limit);

      const safeGuests = guests.map(g => {
        const {
          password, salt, passwordAlgorithm, passwordVersion,
          sessionVersion, verifiedAt, ...safe
        } = g;
        return safe;
      });

      const guestsPage = parseInt(url.searchParams.get('guestsPage')) || 1;
      const guestsLimit = parseInt(url.searchParams.get('guestsLimit')) || 200;
      const guestsOffset = (guestsPage - 1) * guestsLimit;
      const paginatedGuests = safeGuests.slice(guestsOffset, guestsOffset + guestsLimit);

      const ownerMap = new Map();
      const addOwner = (h) => {
        if (!h) return;
        const email = String(h.ownerEmail || '').toLowerCase().trim();
        const wa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
        const key = email || wa || String(h.id || '');
        if (!key) return;

        if (ownerMap.has(key)) {
          const existing = ownerMap.get(key);
          if (h.approved === true || h.verified === true) existing.verified = true;
          if (h.name) existing.homestayNames.push(h.name);
          return;
        }

        ownerMap.set(key, {
          id: h.id,
          ownerName: h.ownerName || '',
          ownerEmail: h.ownerEmail || '',
          whatsapp: h.whatsapp || '',
          verified: h.approved === true || h.verified === true,
          createdAt: h.createdAt || null,
          homestayNames: h.name ? [h.name] : []
        });
      };
      approved.forEach(addOwner);
      pending.forEach(addOwner);
      const owners = [...ownerMap.values()];

      const safeApprovedAdmin = approved.map(stripPasswordFields);
      const safePendingAdmin = pending.map(stripPasswordFields);

      const approvedPage = parseInt(url.searchParams.get('approvedPage')) || 1;
      const approvedLimit = parseInt(url.searchParams.get('approvedLimit')) || DEFAULT_APPROVED_PAGE_SIZE;
      const approvedOffset = (approvedPage - 1) * approvedLimit;
      const paginatedApproved = safeApprovedAdmin.slice(approvedOffset, approvedOffset + approvedLimit);

      const pendingPage = parseInt(url.searchParams.get('pendingPage')) || 1;
      const pendingLimit = parseInt(url.searchParams.get('pendingLimit')) || DEFAULT_PENDING_PAGE_SIZE;
      const pendingOffset = (pendingPage - 1) * pendingLimit;
      const paginatedPending = safePendingAdmin.slice(pendingOffset, pendingOffset + pendingLimit);

      return jsonResponse({
        bookings: paginated,
        total: bookings.length,
        page,
        limit,
        totalPages: Math.ceil(bookings.length / limit),
        approved: paginatedApproved,
        approvedTotal: safeApprovedAdmin.length,
        approvedPage,
        approvedLimit,
        demoOverrides,
        demoBlocked,
        deletedDemo,
        pending: paginatedPending,
        pendingTotal: safePendingAdmin.length,
        pendingPage,
        pendingLimit,
        guests: paginatedGuests,
        guestsTotal: safeGuests.length,
        guestsPage,
        guestsLimit,
        owners
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

    // ============ GUEST BRANCH ============
    if (guestSession && guestSession.type === 'guest') {
      const mine = bookings.filter(b => String(b.guestId) === String(guestSession.userId));
      const paginated = mine.slice(offset, offset + limit);
      return jsonResponse({
        bookings: paginated,
        total: mine.length,
        page,
        limit,
        totalPages: Math.ceil(mine.length / limit)
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

    // ============ PUBLIC BRANCH ============
    const safeApproved = approved
      .filter(h => h && h.approved === true)
      .map(pickPublicFields);

    const availability = {};
    for (const h of safeApproved) {
      const homestayId = String(h.id);
      availability[homestayId] = bookings
        .filter(b => String(b.homestayId) === homestayId && !isDeadBookingStatus(b.status))
        .flatMap(b => getDatesInRange(b.checkin, b.checkout));
    }

    return jsonResponse({ approved: safeApproved, availability }, 200, request, {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
    });

  } catch (e) {
    console.error('Bookings GET error:', e.message, e.stack);
    return jsonResponse({ error: 'Failed to load bookings' }, 500, request);
  }
}

// ============================================================
// POST
// ============================================================
export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  let body;
  try {
    body = await parseJSONSafely(request);
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON or payload too large' }, 400, request);
  }
  const action = body.action;
  const clientIP = getClientIP(request);

  // ============ PUBLIC: CREATE BOOKING ============
  if (action === "createPublicBooking" && body.booking) {
    const auth = await requireGuest(request, env, body);
    if (auth.error) return auth.error;
    const incoming = body.booking;
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);

    const guestId = String(auth.session.userId);
    const rateKey = `createBooking_${guestId}`;
    const rateOk = await checkRateLimit(db, clientIP, rateKey, 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many booking attempts. Please wait 15 minutes.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, rateKey);

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const homestayId = String(incoming.homestayId || '');
    const checkin = String(incoming.checkin || '');
    const checkout = String(incoming.checkout || '');
    const roomId = incoming.roomId ? String(incoming.roomId) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) {
      return jsonResponse({ error: 'Invalid date format' }, 400, request);
    }
    const d1 = new Date(checkin + 'T00:00:00');
    const d2 = new Date(checkout + 'T00:00:00');
    if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
      return jsonResponse({ error: 'Invalid dates' }, 400, request);
    }
    const nights = Math.round((d2 - d1) / 86400000);
    if (nights < 1) return jsonResponse({ error: 'Minimum 1 night' }, 400, request);
    if (nights > MAX_NIGHTS) return jsonResponse({ error: `Maximum ${MAX_NIGHTS} nights` }, 400, request);
    const today = new Date(); today.setHours(0,0,0,0);
    if (d1 < today) return jsonResponse({ error: 'Cannot book past dates' }, 400, request);

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const approvedRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
        let approved = [];
        try { if (approvedRes?.data) approved = JSON.parse(approvedRes.data); } catch(_) {}
        const homestay = approved.find(h => String(h.id) === homestayId && h.approved === true);
        if (!homestay) return { error: 'Homestay not found or not approved', status: 404 };

        let selectedRoom = null;
        const rooms = homestay.rooms || [];
        if (roomId) {
          selectedRoom = rooms.find(r => String(r.id) === roomId);
          if (!selectedRoom) return { error: 'Selected room not found', status: 400 };
        }
        const ownerPrice = selectedRoom ? parseFloat(selectedRoom.price) : homestay.ownerPrice;
        if (!Number.isFinite(ownerPrice) || ownerPrice <= 0) {
          return { error: 'Invalid price configuration', status: 500 };
        }

        const bookingsRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let allBookings = [];
        try { if (bookingsRes?.data) allBookings = JSON.parse(bookingsRes.data); } catch(_) {}

        const guestsRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
        let guests = [];
        try { if (guestsRes?.data) guests = JSON.parse(guestsRes.data); } catch(_) {}

        const guest = guests.find(g => String(g.id) === String(auth.session.userId));
        if (!guest) return { error: 'Guest not found', status: 404 };

        // ============================================================
        // FIX: If the SAME guest already has a Pending Payment OR
        // Payment Failed booking for these exact dates at this
        // homestay, reuse it instead of creating a duplicate.
        // If it was marked Payment Failed, reopen it as Pending.
        // ============================================================
        const existingOwn = allBookings.find(b =>
          String(b.guestId) === String(guest.id) &&
          String(b.homestayId) === String(homestay.id) &&
          b.checkin === checkin &&
          b.checkout === checkout &&
          (b.status === 'Pending Payment' || b.status === 'Payment Failed')
        );
        if (existingOwn) {
          if (existingOwn.status === 'Payment Failed') {
            existingOwn.status = 'Pending Payment';
            existingOwn.date = new Date().toISOString();
            existingOwn.statusUpdated = new Date().toISOString();
            existingOwn.reopenedAt = new Date().toISOString();
            existingOwn.reopenCount = (existingOwn.reopenCount || 0) + 1;
            delete existingOwn.lastPayoutError;
            await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_bookings', JSON.stringify(allBookings))
              .run();
          }
          return { alreadyExists: true, booking: existingOwn, reopened: true };
        }

        const homestayBlocked = new Set((homestay.blockedDates || []).map(String));
        const requestedDates = getDatesInRange(checkin, checkout);
        for (const ds of requestedDates) {
          if (homestayBlocked.has(ds)) {
            return { error: `Selected dates are unavailable (${ds}) due to homestay block`, status: 400 };
          }
        }

        if (selectedRoom) {
          const roomBlocked = new Set((selectedRoom.blockedDates || []).map(String));
          for (const ds of requestedDates) {
            if (roomBlocked.has(ds)) {
              return { error: `Room "${selectedRoom.name}" is blocked on ${ds}`, status: 400 };
            }
          }
        }

        // ============================================================
        // Expire stale Pending Payment AND stale Payment Failed
        // bookings that overlap our request. Then re-check overlap.
        // ============================================================
        const now = Date.now();
        let modified = false;
        allBookings = allBookings.map(b => {
          const s = String(b.status || '');
          const isPending = s === 'Pending Payment';
          const isFailed = s === 'Payment Failed';
          if (!isPending && !isFailed) return b;
          const stamp = b.date ? Date.parse(b.date) : 0;
          if (!stamp) return b;
          const isStale = (now - stamp) > PENDING_EXPIRY_MS;
          if (!isStale) return b;
          const roomMatch = selectedRoom
            ? String(b.roomId) === String(selectedRoom.id)
            : String(b.homestayId) === String(homestay.id);
          if (!roomMatch) return b;
          const overlaps = checkin < String(b.checkout || '') && checkout > String(b.checkin || '');
          if (!overlaps) return b;
          modified = true;
          return { ...b, status: 'Expired - Abandoned', statusUpdated: new Date().toISOString() };
        });

        const overlaps = allBookings.some(b => {
          const isOwnPending = String(b.guestId) === String(guest.id) &&
            (b.status === 'Pending Payment' || b.status === 'Payment Failed');
          const roomMatch = selectedRoom
            ? String(b.roomId) === String(selectedRoom.id)
            : String(b.homestayId) === String(homestay.id);
          return roomMatch &&
                 !isDeadBookingStatus(b.status) &&
                 !isOwnPending &&
                 checkin < String(b.checkout||'') &&
                 checkout > String(b.checkin||'');
        });
        if (overlaps) {
          return { error: 'Selected dates are already booked for this room', status: 400 };
        }

        const base = Math.round(ownerPrice * nights * 100) / 100;
        const fee = Math.round(base * 0.11 * 100) / 100;
        const gatewayFee = GATEWAY_FEE;
        const total = Math.round((base + fee + gatewayFee) * 100) / 100;

        let bookingId = String(incoming.id || '');
        if (!/^KDH-[A-Za-z0-9_-]{4,40}$/.test(bookingId) || allBookings.some(b=>String(b.id)===bookingId)) {
          bookingId = `KDH-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
        }

        const booking = {
          id: bookingId,
          homestay: homestay.name,
          homestayId: homestay.id,
          ownerWhatsapp: homestay.whatsapp || '',
          guestId: guest.id,
          guestName: guest.name,
          guestEmail: guest.email,
          guestPhone: guest.phone || '',
          checkin: checkin,
          checkout: checkout,
          nights: nights,
          base: base,
          fee: fee,
          gatewayFee: gatewayFee,
          total: total,
          status: 'Pending Payment',
          date: new Date().toISOString(),
          roomId: selectedRoom ? selectedRoom.id : null,
          roomName: selectedRoom ? selectedRoom.name : null,
          roomImages: selectedRoom ? (selectedRoom.images || []) : []
        };

        allBookings.push(booking);

        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(allBookings))
          .run();

        return { booking, expiredCount: modified ? 1 : 0 };
      }, 30000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        return jsonResponse({ error: 'Another booking is being processed. Please try again in a moment.' }, 429, request);
      }
      throw lockErr;
    }

    if (result.error) {
      return jsonResponse({ error: result.error }, result.status || 400, request);
    }

    if (result.alreadyExists) {
      return jsonResponse({
        success: true,
        booking: result.booking,
        alreadyExists: true,
        message: result.reopened
          ? 'Your previous payment attempt failed. We reopened the same booking so you can retry safely.'
          : 'You already have a pending booking for these dates. Please complete the payment.'
      }, 200, request);
    }

    const booking = result.booking;

    await logAction({
      db,
      action: 'booking_created',
      admin: 'guest',
      details: `Booking ${booking.id} created; payment pending${result.expiredCount ? ' (expired stale overlap)' : ''}`,
      ip: clientIP,
      userId: booking.guestId,
      homestayId: booking.homestayId
    });

    return jsonResponse({ success: true, booking: booking }, 200, request);
  }

  // ============ PUBLIC: MARK PAYMENT FAILED ONLY ============
  if (action === "publicUpdateStatus" && body.id) {
    const auth = await requireGuest(request, env, body);
    if (auth.error) return auth.error;

    if (body.status !== 'Payment Failed') {
      return jsonResponse({
        error: 'Guests cannot cancel bookings directly. Please contact the host if you need to cancel.'
      }, 403, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bookings = [];
          try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
          const idx = bookings.findIndex(b => String(b.id) === String(body.id));
          if (idx < 0) return { error: 'Invalid request.', status: 400 };
          const b = bookings[idx];
          if (String(b.guestId) !== String(auth.session.userId)) {
            return { error: 'Unauthorized', status: 403 };
          }

          const currentStatus = String(b.status || '');
          const isTerminal = currentStatus === 'Paid - Awaiting Check-in'
            || currentStatus.startsWith('Completed')
            || /cancelled|refunded|expired/i.test(currentStatus);

          if (isTerminal) {
            return { noop: true, booking: b };
          }

          bookings[idx] = {
            ...b,
            status: 'Payment Failed',
            failed_at: new Date().toISOString(),
            statusUpdated: new Date().toISOString()
          };

          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings)).run();

          return { updated: true, booking: bookings[idx] };
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) {
        return jsonResponse({ error: result.error }, result.status || 400, request);
      }
      if (result.noop) {
        return jsonResponse({ success: true, booking: result.booking, message: 'Booking already finalised.' }, 200, request);
      }

      await logAction({
        db,
        action: 'public_status_updated',
        admin: 'guest',
        details: `Booking ${result.booking.id} marked as Payment Failed`,
        ip: clientIP,
        userId: result.booking.guestId,
        homestayId: result.booking.homestayId
      });

      return jsonResponse({ success: true, booking: result.booking }, 200, request);
    } catch (e) {
      console.error('Guest status update error:', e.message);
      return jsonResponse({ error: 'Could not update booking' }, 500, request);
    }
  }

  // ============ ADMIN ACTIONS ============
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: 'DB not configured' }), {
      status: 500, headers: corsHeaders(request)
    });
  }

  const adminIP = getClientIP(request);
  const rateOk = await checkRateLimit(db, adminIP, 'admin_action', 100, 60);
  if (!rateOk) {
    return jsonResponse({ error: 'Too many admin actions. Please slow down.' }, 429, request);
  }
  await recordRateLimit(db, adminIP, 'admin_action');

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ---- Admin: clearAll ----
    if (action === "clearAll") {
      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify([]))
            .run();
          return { success: true };
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }
      await logAction({
        db,
        action: 'bookings_cleared',
        admin: 'admin',
        details: 'All bookings cleared via clearAll action',
        ip: clientIP
      });
      return jsonResponse({ success: true, bookings: [] }, 200, request);
    }

    // ---- Admin: updateStatus ----
    if (action === "updateStatus" && body.id) {
      const newStatus = String(body.status || '');
      if (!newStatus) {
        return jsonResponse({ error: 'Missing status' }, 400, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          let bookings = [];
          if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
          const idx = bookings.findIndex(b => String(b.id) === String(body.id));
          if (idx === -1) return { error: 'Booking not found', status: 404 };

          const patch = {};
          if (body.booking && typeof body.booking === 'object') {
            for (const key of ADMIN_STATUS_FIELD_WHITELIST) {
              if (body.booking[key] !== undefined) patch[key] = body.booking[key];
            }
          }
          patch.status = newStatus;
          patch.statusUpdated = new Date().toISOString();

          bookings[idx] = { ...bookings[idx], ...patch };

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          return { success: true, booking: bookings[idx] };
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another booking operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) {
        return jsonResponse({ error: result.error }, result.status || 400, request);
      }

      await logAction({
        db,
        action: 'booking_status_updated',
        admin: 'admin',
        details: `Booking ${body.id} status changed to ${newStatus}`,
        ip: clientIP,
        userId: result.booking.guestEmail,
        homestayId: result.booking.homestayId
      });

      return jsonResponse({ success: true, booking: result.booking }, 200, request);
    }

    // ---- Admin: updateDates ----
    if (action === "updateDates" && body.id) {
      const newCheckin = String(body.checkin || '');
      const newCheckout = String(body.checkout || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newCheckin) || !/^\d{4}-\d{2}-\d{2}$/.test(newCheckout)) {
        return jsonResponse({ error: 'Invalid date format' }, 400, request);
      }
      const d1 = new Date(newCheckin + 'T00:00:00');
      const d2 = new Date(newCheckout + 'T00:00:00');
      if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
        return jsonResponse({ error: 'Invalid dates' }, 400, request);
      }
      const newNights = Math.round((d2 - d1) / 86400000);
      if (newNights < 1) return jsonResponse({ error: 'Minimum 1 night' }, 400, request);
      if (newNights > MAX_NIGHTS) {
        return jsonResponse({ error: `Maximum ${MAX_NIGHTS} nights` }, 400, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          let bookings = [];
          if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
          const idx = bookings.findIndex(b => String(b.id) === String(body.id));
          if (idx === -1) return { error: 'Booking not found', status: 404 };

          const booking = bookings[idx];

          const approvedRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
          let approved = [];
          try { if (approvedRes?.data) approved = JSON.parse(approvedRes.data); } catch(_) {}
          const homestay = approved.find(h => String(h.id) === String(booking.homestayId));
          if (!homestay) return { error: 'Homestay not found', status: 404 };

          let unitPrice = Number(homestay.ownerPrice);
          if (booking.roomId && Array.isArray(homestay.rooms)) {
            const room = homestay.rooms.find(rm => String(rm.id) === String(booking.roomId));
            if (room && Number.isFinite(Number(room.price))) {
              unitPrice = Number(room.price);
            }
          }
          if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
            return { error: 'Invalid price configuration on homestay', status: 500 };
          }

          const base = Math.round(unitPrice * newNights * 100) / 100;
          const fee = Math.round(base * 0.11 * 100) / 100;
          const gatewayFee = GATEWAY_FEE;
          const total = Math.round((base + fee + gatewayFee) * 100) / 100;
          const youReceive = Math.round((base) * 100) / 100;

          bookings[idx] = {
            ...booking,
            checkin: newCheckin,
            checkout: newCheckout,
            nights: newNights,
            base,
            fee,
            gatewayFee,
            total,
            youReceive,
            statusUpdated: new Date().toISOString()
          };

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          return { success: true, booking: bookings[idx] };
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another booking operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) {
        return jsonResponse({ error: result.error }, result.status || 400, request);
      }

      await logAction({
        db,
        action: 'booking_dates_changed',
        admin: 'admin',
        details: `Booking ${body.id} dates changed to ${newCheckin}→${newCheckout} (server-recomputed amount RM${result.booking.total})`,
        ip: clientIP,
        userId: result.booking.guestEmail,
        homestayId: result.booking.homestayId
      });

      return jsonResponse({ success: true, booking: result.booking }, 200, request);
    }

    // ---- Admin: approveHomestay ----
    if (action === "approveHomestay" && body.id) {
      try {
        const pendingRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
        let pending = [];
        if (pendingRes && pendingRes.data) {
          try { pending = JSON.parse(pendingRes.data); } catch(e) {
            return jsonResponse({ error: 'Corrupt pending data' }, 500, request);
          }
        }
        const idx = pending.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return jsonResponse({ error: 'Pending homestay not found' }, 404, request);
        }
        const homestay = pending[idx];

        const {
          icImage, icOriginalName, icUploadDate,
          bankQRImage, bankQROriginalName, pbtLicense,
          ownerPasswordHash, ownerSalt, ownerPasswordAlgorithm, ownerPasswordVersion,
          ...safeHomestay
        } = homestay;
        safeHomestay.approved = true;
        safeHomestay.verified = true;
        pending.splice(idx, 1);

        const approvedRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
        let approved = [];
        if (approvedRes && approvedRes.data) {
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            return jsonResponse({ error: 'Corrupt approved data' }, 500, request);
          }
        }
        approved.push(safeHomestay);

        const homestaysRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_homestays').first();
        let allHomes = [];
        if (homestaysRes && homestaysRes.data) {
          try { allHomes = JSON.parse(homestaysRes.data); } catch(e) {}
        }
        const hIdx = allHomes.findIndex(h => String(h.id) === String(safeHomestay.id));
        if (hIdx !== -1) {
          const cleanHome = { ...allHomes[hIdx] };
          delete cleanHome.icImage;
          delete cleanHome.icOriginalName;
          delete cleanHome.icUploadDate;
          delete cleanHome.bankQRImage;
          delete cleanHome.bankQROriginalName;
          delete cleanHome.pbtLicense;
          delete cleanHome.ownerPasswordHash;
          delete cleanHome.ownerSalt;
          delete cleanHome.ownerPasswordAlgorithm;
          delete cleanHome.ownerPasswordVersion;
          cleanHome.approved = true;
          cleanHome.verified = true;
          allHomes[hIdx] = cleanHome;
        }

        await db.batch([
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)').bind('kd_pending', JSON.stringify(pending)),
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)').bind('kd_approved', JSON.stringify(approved)),
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)').bind('kd_homestays', JSON.stringify(allHomes))
        ]);

        await invalidateOwnerSessionsForHomestay(db, safeHomestay.id);

        await logAction({
          db,
          action: 'homestay_approved',
          admin: 'admin',
          details: `Approved homestay "${safeHomestay.name}" (ID: ${safeHomestay.id}) by ${safeHomestay.ownerName}`,
          ip: clientIP,
          userId: safeHomestay.ownerEmail,
          homestayId: safeHomestay.id
        });

        return jsonResponse({ success: true, homestay: safeHomestay }, 200, request);
      } catch (approveErr) {
        console.error('Approve homestay error:', approveErr.message);
        return jsonResponse({ error: 'Approval failed. Please try again later.' }, 500, request);
      }
    }

    // ---- Admin: rejectHomestay (with email) ----
    if (action === "rejectHomestay" && body.id) {
      const pendingRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
      let pending = [];
      if (pendingRes && pendingRes.data) {
        try { pending = JSON.parse(pendingRes.data); } catch(e) {}
      }
      const idx = pending.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return jsonResponse({ error: 'Pending homestay not found' }, 404, request);
      }
      const homestay = pending[idx];
      const reason = String(body.reason || '').slice(0, 500).trim();

      pending.splice(idx, 1);
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_pending', JSON.stringify(pending))
        .run();

      await invalidateOwnerSessionsForHomestay(db, homestay.id);

      const emailResult = await sendRejectionEmail(homestay, reason, env);

      await logAction({
        db,
        action: 'homestay_rejected',
        admin: 'admin',
        details: `Rejected homestay "${homestay.name}" (ID: ${homestay.id}). Reason: ${reason || '(none)'}. Email: ${emailResult.sent ? 'sent' : 'failed — ' + (emailResult.error || 'unknown')}`,
        ip: clientIP,
        userId: homestay.ownerEmail,
        homestayId: homestay.id
      });

      return jsonResponse({
        success: true,
        emailSent: emailResult.sent,
        emailError: emailResult.sent ? undefined : emailResult.error
      }, 200, request);
    }

    // ---- Admin: removeApprovedHomestay ----
    if (action === "removeApprovedHomestay" && body.id) {
      try {
        const isDemo = body.isDemo === true;

        const approvedRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
        let approved = [];
        if (approvedRes && approvedRes.data) {
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            return jsonResponse({ error: 'Corrupt approved data' }, 500, request);
          }
        }

        const idx = approved.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return jsonResponse({ error: 'Approved homestay not found' }, 404, request);
        }

        const removed = approved[idx];
        approved.splice(idx, 1);

        if (isDemo) {
          const demoRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_deleted_demo').first();
          let deletedDemo = [];
          if (demoRes && demoRes.data) {
            try { deletedDemo = JSON.parse(demoRes.data); } catch(e) {}
          }
          if (!Array.isArray(deletedDemo)) deletedDemo = [];
          if (!deletedDemo.includes(String(body.id))) {
            deletedDemo.push(String(body.id));
          }
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_deleted_demo', JSON.stringify(deletedDemo))
            .run();
        }

        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_approved', JSON.stringify(approved))
          .run();

        await invalidateOwnerSessionsForHomestay(db, removed.id);

        await logAction({
          db,
          action: 'homestay_removed',
          admin: 'admin',
          details: `Removed homestay "${removed.name}" (ID: ${removed.id}) from approved`,
          ip: clientIP,
          userId: removed.ownerEmail,
          homestayId: removed.id
        });

        return jsonResponse({ success: true, removed: removed }, 200, request);
      } catch (removeErr) {
        console.error('Remove homestay error:', removeErr.message);
        return jsonResponse({ error: 'Remove failed. Please try again later.' }, 500, request);
      }
    }

    // ---- Admin: deleteOwner ----
    if (action === "deleteOwner") {
      const ownerId = body.ownerId ? String(body.ownerId) : '';
      const email = body.email ? String(body.email).toLowerCase().trim() : '';
      const whatsapp = body.whatsapp ? String(body.whatsapp).replace(/[^0-9]/g, '') : '';

      if (!ownerId && !email && !whatsapp) {
        return jsonResponse({ error: 'Owner identifier is required' }, 400, request);
      }

      const approvedRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
      const pendingRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
      const homestaysRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_homestays').first();

      let approved = []; try { if (approvedRes?.data) approved = JSON.parse(approvedRes.data); } catch (_) {}
      let pending = []; try { if (pendingRes?.data) pending = JSON.parse(pendingRes.data); } catch (_) {}
      let allHomes = []; try { if (homestaysRes?.data) allHomes = JSON.parse(homestaysRes.data); } catch (_) {}

      const initialMatches = [...approved, ...pending].filter(h => {
        const hId = String(h.id || '');
        const hEmail = String(h.ownerEmail || '').toLowerCase().trim();
        const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
        if (ownerId && hId === ownerId) return true;
        if (email && hEmail === email) return true;
        if (whatsapp && hWa === whatsapp) return true;
        return false;
      });

      if (initialMatches.length === 0) {
        return jsonResponse({ error: 'Owner not found' }, 404, request);
      }

      const targetIds = new Set(initialMatches.map(h => String(h.id)));
      const targetEmails = new Set(
        initialMatches.map(h => String(h.ownerEmail || '').toLowerCase().trim()).filter(Boolean)
      );
      const targetWhatsapps = new Set(
        initialMatches.map(h => String(h.whatsapp || '').replace(/[^0-9]/g, '')).filter(Boolean)
      );

      const matches = (h) => {
        const hId = String(h.id || '');
        const hEmail = String(h.ownerEmail || '').toLowerCase().trim();
        const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
        if (targetIds.has(hId)) return true;
        if (hEmail && targetEmails.has(hEmail)) return true;
        if (hWa && targetWhatsapps.has(hWa)) return true;
        return false;
      };

      const removedApproved = approved.filter(matches);
      const removedPending = pending.filter(matches);

      approved = approved.filter(h => !matches(h));
      pending = pending.filter(h => !matches(h));
      allHomes = allHomes.filter(h => !matches(h));

      await db.batch([
        db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_approved', JSON.stringify(approved)),
        db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_pending', JSON.stringify(pending)),
        db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_homestays', JSON.stringify(allHomes))
      ]);

      for (const h of [...removedApproved, ...removedPending]) {
        try { await invalidateOwnerSessionsForHomestay(db, h.id); } catch (_) {}
      }

      await logAction({
        db,
        action: 'owner_deleted',
        admin: 'admin',
        details: `Deleted owner (id=${ownerId}, email=${email}) — removed ${removedApproved.length} approved + ${removedPending.length} pending homestays`,
        ip: clientIP,
        userId: email || ownerId
      });

      return jsonResponse({
        success: true,
        removedHomes: {
          approved: removedApproved.length,
          pending: removedPending.length
        },
        removedIds: [...targetIds]
      }, 200, request);
    }

    // ---- Admin: deleteGuest ----
    if (action === "deleteGuest") {
      const guestId = body.guestId ? String(body.guestId) : '';
      const email = body.email ? String(body.email).toLowerCase().trim() : '';

      if (!guestId && !email) {
        return jsonResponse({ error: 'Guest ID or email is required' }, 400, request);
      }

      const guestRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
      let guests = [];
      if (guestRes?.data) { try { guests = JSON.parse(guestRes.data); } catch (_) {} }

      const deleted = guests.find(g =>
        (guestId && String(g.id) === guestId) ||
        (email && String(g.email || '').toLowerCase().trim() === email)
      );

      if (!deleted) {
        return jsonResponse({ error: 'Guest not found' }, 404, request);
      }

      const deletedEmail = String(deleted.email || '').toLowerCase().trim();
      const deletedId = String(deleted.id || '');
      const remainingGuests = guests.filter(g => {
        const sameId = deletedId && String(g.id || '') === deletedId;
        const sameEmail = deletedEmail && String(g.email || '').toLowerCase().trim() === deletedEmail;
        return !sameId && !sameEmail;
      });

      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(remainingGuests)).run();

      await logAction({
        db,
        action: 'guest_deleted',
        admin: 'admin',
        details: `Deleted guest ${deletedEmail || deletedId}`,
        ip: clientIP,
        userId: deletedId || deletedEmail
      });

      return jsonResponse({
        success: true,
        deleted: { id: deletedId, email: deletedEmail }
      }, 200, request);
    }

    // ---- Admin: updateHomestays (bulk sync) ----
    if (action === "updateHomestays") {
      const { approved, demoOverrides, demoBlocked, deletedDemo } = body;

      if (!Array.isArray(approved)) {
        return jsonResponse({ error: 'Invalid approved data' }, 400, request);
      }

      for (const h of approved) {
        if (!h || typeof h !== 'object' || !h.id || !h.name) {
          return jsonResponse({ error: 'Invalid homestay entry in approved array' }, 400, request);
        }
      }

      const stmts = [];
      stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_approved', JSON.stringify(approved)));

      if (demoOverrides !== undefined) {
        stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_demo_overrides', JSON.stringify(demoOverrides)));
      }
      if (demoBlocked !== undefined) {
        stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_demo_blocked', JSON.stringify(demoBlocked)));
      }
      if (deletedDemo !== undefined) {
        stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_deleted_demo', JSON.stringify(deletedDemo)));
      }

      await db.batch(stmts);

      await logAction({
        db,
        action: 'homestays_updated',
        admin: 'admin',
        details: `Updated ${approved.length} approved homestays`,
        ip: clientIP,
        userId: 'admin'
      });

      return jsonResponse({ success: true, approved }, 200, request);
    }

    return jsonResponse({ success: true, message: 'Synced' }, 200, request);

  } catch (err) {
    console.error('Bookings POST admin action error:', err.message);
    return jsonResponse({ error: 'An internal error occurred. Please try again later.' }, 500, request);
  }
}

// ============================================================
// DELETE (single booking)
// ============================================================
export async function onRequestDelete({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return jsonResponse({ error: 'Missing booking id' }, 400, request);
  }

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
  await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

  let result;
  try {
    result = await withLock(db, BOOKINGS_LOCK, async (db) => {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
      let bookings = [];
      try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
      const idx = bookings.findIndex(b => String(b.id) === String(id));
      if (idx === -1) return { error: 'Booking not found', status: 404 };
      const deleted = bookings[idx];
      bookings.splice(idx, 1);
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return { success: true, deleted };
    }, 30000);
  } catch (lockErr) {
    if (lockErr.message && lockErr.message.includes('in progress')) {
      return jsonResponse({ error: 'Another booking operation is in progress. Please try again in a moment.' }, 429, request);
    }
    throw lockErr;
  }

  if (result.error) {
    return jsonResponse({ error: result.error }, result.status || 400, request);
  }

  await logAction({
    db,
    action: 'booking_deleted_admin',
    admin: 'admin',
    details: `Deleted booking ${id} (${result.deleted.homestay})`,
    ip: getClientIP(request),
    userId: result.deleted.guestId,
    homestayId: result.deleted.homestayId
  });

  return jsonResponse({ success: true, deleted: result.deleted }, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
