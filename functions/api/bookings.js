// /api/bookings.js – FULLY PATCHED with unified fee + clearAll + approve cleanup + public data sanitization + deleteOwner
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  validateCSRFToken,
  getCSRFToken,
  getGuestSession,
  getAdminToken,
  jsonResponse,
  parseJSONSafely,
  withLock,
  checkRateLimit,
  recordRateLimit,
  invalidateOwnerSessions
} from './_utils.js';

const MAX_NIGHTS = 60;
const DEFAULT_PAGE_SIZE = 50;
const GATEWAY_FEE = 1.00;

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

async function verifyAdmin(request, env) {
  const auth = await getAdminToken(request);
  if (!env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers: corsHeaders(request) });
  if (auth !== env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders(request) });
  return null;
}

async function requireGuest(request, env, body) {
  const session = await getGuestSession(request, env);
  if (!session || session.type !== 'guest') return { error: jsonResponse({ error: 'Authentication required' }, 401, request) };
  const guestId = body?.booking?.guestId || body?.guestId;
  if (guestId && String(guestId) !== String(session.userId)) return { error: jsonResponse({ error: 'Guest identity mismatch' }, 403, request) };
  const csrf = getCSRFToken(request);
  if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) return { error: jsonResponse({ error: 'Invalid security token' }, 403, request) };
  return { session };
}

// ===== Sanitize homestay for public consumption =====
function sanitizePublicHomestay(h) {
  if (!h) return null;
  const {
    id, name, location, description, image, images, rooms,
    ownerPrice, guests, bedrooms, rating, reviews, verified, approved, blockedDates
  } = h;
  return {
    id, name, location, description, image, images,
    rooms: Array.isArray(rooms) ? rooms.map(r => ({
      id: r.id,
      name: r.name,
      price: r.price,
      guests: r.guests,
      desc: r.desc,
      images: r.images || [],
      blockedDates: r.blockedDates || []
    })) : [],
    ownerPrice, guests, bedrooms, rating, reviews, verified, approved,
    blockedDates: Array.isArray(blockedDates) ? blockedDates : []
  };
}

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const guestSession = await getGuestSession(request, env);
    const adminToken = await getAdminToken(request);
    const isAdmin = adminToken && adminToken === env.ADMIN_TOKEN;

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

    if (isAdmin) {
      const paginated = bookings.slice(offset, offset + limit);

      // Load owners list (kd_owners)
      let ownersList = [];
      try {
        const ownersRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
        if (ownersRes?.data) ownersList = JSON.parse(ownersRes.data);
      } catch (_) {}

      return jsonResponse({
        bookings: paginated,
        total: bookings.length,
        page,
        limit,
        totalPages: Math.ceil(bookings.length / limit),
        approved,
        demoOverrides,
        demoBlocked,
        deletedDemo,
        pending,
        owners: ownersList.map(o => {
          const {
            ownerPasswordHash, ownerSalt, ownerPasswordAlgorithm,
            ownerPasswordVersion, ownerSessionVersion, ...safe
          } = o;
          return safe;
        }),
        guests: guests.map(g => { const { password, salt, ...safe } = g; return safe; })
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

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

    // ===== PUBLIC BRANCH – SANITIZED =====
    const sanitizedApproved = approved.map(sanitizePublicHomestay).filter(Boolean);

    const availability = {};
    for (const h of approved) {
      const homestayId = String(h.id);
      availability[homestayId] = bookings
        .filter(b => String(b.homestayId) === homestayId && !/cancelled|failed|expired/i.test(String(b.status || '')))
        .flatMap(b => getDatesInRange(b.checkin, b.checkout));
    }

    return jsonResponse({ approved: sanitizedApproved, availability }, 200, request, {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
    });

  } catch (e) {
    console.error('Bookings GET error:', e.message);
    return jsonResponse({ error: 'Failed to load bookings' }, 500, request);
  }
}

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

  // ========== PUBLIC ACTIONS ==========
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

    const approvedRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
    let approved = [];
    try { if (approvedRes?.data) approved = JSON.parse(approvedRes.data); } catch(_) {}
    const homestay = approved.find(h => String(h.id) === homestayId && h.approved === true);
    if (!homestay) return jsonResponse({ error: 'Homestay not found or not approved' }, 404, request);

    let selectedRoom = null;
    const rooms = homestay.rooms || [];
    if (roomId) {
      selectedRoom = rooms.find(r => String(r.id) === roomId);
      if (!selectedRoom) return jsonResponse({ error: 'Selected room not found' }, 400, request);
    }
    const ownerPrice = selectedRoom ? parseFloat(selectedRoom.price) : homestay.ownerPrice;
    if (!Number.isFinite(ownerPrice) || ownerPrice <= 0) {
      return jsonResponse({ error: 'Invalid price configuration' }, 500, request);
    }

    try {
      const result = await withLock(db, homestayId, async (db) => {
        const bookingsRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let allBookings = [];
        try { if (bookingsRes?.data) allBookings = JSON.parse(bookingsRes.data); } catch(_) {}

        const guestsRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
        let guests = [];
        try { if (guestsRes?.data) guests = JSON.parse(guestsRes.data); } catch(_) {}

        const guest = guests.find(g => String(g.id) === String(auth.session.userId));
        if (!guest) {
          throw new Error('Guest not found');
        }

        const existingPending = allBookings.find(b =>
          String(b.guestId) === String(guest.id) &&
          String(b.homestayId) === String(homestay.id) &&
          b.checkin === checkin &&
          b.checkout === checkout &&
          b.status === 'Pending Payment'
        );
        if (existingPending) {
          return { alreadyExists: true, booking: existingPending };
        }

        const homestayBlocked = new Set((homestay.blockedDates || []).map(String));
        const requestedDates = getDatesInRange(checkin, checkout);
        for (const ds of requestedDates) {
          if (homestayBlocked.has(ds)) {
            throw new Error(`Selected dates are unavailable (${ds}) due to homestay block`);
          }
        }

        if (selectedRoom) {
          const roomBlocked = new Set((selectedRoom.blockedDates || []).map(String));
          for (const ds of requestedDates) {
            if (roomBlocked.has(ds)) {
              throw new Error(`Room "${selectedRoom.name}" is blocked on ${ds}`);
            }
          }
        }

        const overlaps = allBookings.some(b => {
          const pendingExpired = String(b.status||'') === 'Pending Payment' && b.date && Date.now() - Date.parse(b.date) > 15*60*1000;
          const isOwnPending = String(b.guestId) === String(guest.id) && b.status === 'Pending Payment';
          const roomMatch = selectedRoom ? String(b.roomId) === String(selectedRoom.id) : String(b.homestayId) === String(homestay.id);
          return roomMatch &&
                 !pendingExpired &&
                 !/cancelled|failed|expired/i.test(String(b.status||'')) &&
                 !isOwnPending &&
                 checkin < String(b.checkout||'') &&
                 checkout > String(b.checkin||'');
        });
        if (overlaps) {
          throw new Error('Selected dates are already booked for this room');
        }

        const base = Math.round(ownerPrice * nights * 100) / 100;
        const fee = Math.round(base * 0.11 * 100) / 100;
        const gatewayFee = GATEWAY_FEE;
        const total = Math.round((base + fee + gatewayFee) * 100) / 100;
        let bookingId = String(incoming.id || '');
        if (!/^KDH-[A-Za-z0-9_-]{4,40}$/.test(bookingId) || allBookings.some(b=>String(b.id)===bookingId)) {
          bookingId = `KDH-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
        }
        const checkinCode = String(Math.floor(100000 + Math.random() * 900000));

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
          checkinCode: checkinCode,
          roomId: selectedRoom ? selectedRoom.id : null,
          roomName: selectedRoom ? selectedRoom.name : null,
          roomImages: selectedRoom ? (selectedRoom.images || []) : []
        };

        allBookings.push(booking);

        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(allBookings))
          .run();

        return { booking };
      });

      if (result.alreadyExists) {
        return jsonResponse({
          success: true,
          booking: result.booking,
          alreadyExists: true,
          message: 'You already have a pending booking for these dates. Please complete the payment.'
        }, 200, request);
      }

      const booking = result.booking;

      await logAction({
        db,
        action: 'booking_created',
        admin: 'guest',
        details: `Booking ${booking.id} created; payment pending`,
        ip: clientIP,
        userId: booking.guestId,
        homestayId: booking.homestayId
      });

      return jsonResponse({ success: true, booking: booking }, 200, request);

    } catch (err) {
      console.error('Create booking error:', err.message);
      return jsonResponse({ error: 'Unable to create booking. Please try again later.' }, 500, request);
    }
  }

  // ========== PUBLIC UPDATE STATUS ==========
  if (action === "publicUpdateStatus" && body.id) {
    const auth = await requireGuest(request, env, body);
    if (auth.error) return auth.error;

    const allowedStatuses = ['Cancelled by Guest', 'Payment Failed'];
    if (!allowedStatuses.includes(body.status)) {
      return jsonResponse({ error: 'Guests may only cancel or mark as failed.' }, 403, request);
    }

    const db = env.DB; if (!db) return jsonResponse({error:'DB not configured'},500,request);
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
      const r=await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
      let bookings=[]; try{if(r?.data)bookings=JSON.parse(r.data)}catch(_){}
      const idx=bookings.findIndex(b=>String(b.id)===String(body.id));
      if(idx<0) return jsonResponse({ error: 'Invalid request.' }, 400, request);
      const b=bookings[idx];
      if(String(b.guestId)!==String(auth.session.userId)) return jsonResponse({ error: 'Unauthorized' }, 403, request);

      if (body.status === 'Cancelled by Guest') {
        const paidStatuses = ['Paid - Awaiting Check-in', 'Completed'];
        if (paidStatuses.includes(b.status)) {
          return jsonResponse({ error: 'You cannot cancel a booking that has already been paid. Please contact support.' }, 403, request);
        }
        const today = new Date();
        today.setHours(0,0,0,0);
        const checkinDate = new Date(b.checkin + 'T00:00:00');
        if (checkinDate <= today) {
          return jsonResponse({ error: 'You cannot cancel a booking on or after the check‑in date.' }, 403, request);
        }
      }

      bookings[idx]={...b,status:body.status,statusUpdated:new Date().toISOString()};

      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings',JSON.stringify(bookings)).run();

      await logAction({
        db,
        action:'public_status_updated',
        admin:'guest',
        details:`Booking ${b.id} status updated to ${body.status}`,
        ip:clientIP,
        userId:b.guestId,
        homestayId:b.homestayId
      });

      return jsonResponse({success:true,booking:bookings[idx]},200,request);
    } catch(e) {
      console.error('Guest status update error:', e.message);
      return jsonResponse({ error: 'Could not update booking' }, 500, request);
    }
  }

  // ========== ADMIN ACTIONS ==========
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders(request) });
  }

  const adminIP = getClientIP(request);
  const rateOk = await checkRateLimit(db, adminIP, 'admin_action', 100, 60);
  if (!rateOk) {
    return jsonResponse({ error: 'Too many admin actions. Please slow down.' }, 429, request);
  }
  await recordRateLimit(db, adminIP, 'admin_action');

  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // ---- Admin: clearAll ----
    if (action === "clearAll") {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify([]))
        .run();
      await logAction({
        db,
        action: 'bookings_cleared',
        admin: 'admin',
        details: 'All bookings cleared via clearAll action',
        ip: clientIP
      });
      return jsonResponse({ success: true, bookings: [] }, 200, request);
    }

    // ---- Admin updateStatus ----
    if (action === "updateStatus" && body.id) {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = [];
      if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
      const idx = bookings.findIndex(b => String(b.id) === String(body.id));
      if (idx === -1) {
        return jsonResponse({ error: "Booking not found" }, 404, request);
      }
      bookings[idx].status = body.status;
      bookings[idx].statusUpdated = new Date().toISOString();
      if (body.booking) {
        bookings[idx] = { ...bookings[idx], ...body.booking };
      }
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();

      await logAction({
        db,
        action: 'booking_status_updated',
        admin: 'admin',
        details: `Booking ${body.id} status changed to ${body.status}`,
        ip: clientIP,
        userId: bookings[idx].guestEmail,
        homestayId: bookings[idx].homestayId
      });

      return jsonResponse({ success: true, booking: bookings[idx] }, 200, request);
    }

    // ---- Admin updateDates ----
    if (action === "updateDates" && body.id) {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = [];
      if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
      const idx = bookings.findIndex(b => String(b.id) === String(body.id));
      if (idx === -1) {
        return jsonResponse({ error: "Booking not found" }, 404, request);
      }
      bookings[idx].checkin = body.checkin;
      bookings[idx].checkout = body.checkout;
      bookings[idx].nights = body.nights;
      bookings[idx].base = body.base;
      bookings[idx].fee = body.fee;
      bookings[idx].total = body.total;
      bookings[idx].youReceive = body.youReceive;
      bookings[idx].statusUpdated = new Date().toISOString();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();

      await logAction({
        db,
        action: 'booking_dates_changed',
        admin: 'admin',
        details: `Booking ${body.id} dates changed to ${body.checkin}→${body.checkout}`,
        ip: clientIP,
        userId: bookings[idx].guestEmail,
        homestayId: bookings[idx].homestayId
      });

      return jsonResponse({ success: true, booking: bookings[idx] }, 200, request);
    }

    // ---- Admin approveHomestay ----
    if (action === "approveHomestay" && body.id) {
      try {
        const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
        let pending = [];
        if (pendingRes && pendingRes.data) {
          try { pending = JSON.parse(pendingRes.data); } catch(e) {
            return jsonResponse({ error: "Corrupt pending data" }, 500, request);
          }
        }
        const idx = pending.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return jsonResponse({ error: "Pending homestay not found" }, 404, request);
        }
        const homestay = pending[idx];

        const {
          icImage, icOriginalName, bankQRImage, bankQROriginalName, pbtLicense,
          ...safeHomestay
        } = homestay;
        safeHomestay.approved = true;
        safeHomestay.verified = true;
        pending.splice(idx, 1);

        const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
        let approved = [];
        if (approvedRes && approvedRes.data) {
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            return jsonResponse({ error: "Corrupt approved data" }, 500, request);
          }
        }
        approved.push(safeHomestay);

        const homestaysRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_homestays").first();
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

        const stmt1 = db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_pending", JSON.stringify(pending));
        const stmt2 = db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_approved", JSON.stringify(approved));
        const stmt3 = db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_homestays", JSON.stringify(allHomes));
        await db.batch([stmt1, stmt2, stmt3]);

        await invalidateOwnerSessions(db, safeHomestay.id);

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
        console.error("Approve homestay error:", approveErr.message);
        return jsonResponse({ error: "Approval failed. Please try again later." }, 500, request);
      }
    }

    // ---- Admin rejectHomestay ----
    if (action === "rejectHomestay" && body.id) {
      const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      let pending = [];
      if (pendingRes && pendingRes.data) { try { pending = JSON.parse(pendingRes.data); } catch(e) {} }
      const idx = pending.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return jsonResponse({ error: "Pending homestay not found" }, 404, request);
      }
      const homestay = pending[idx];
      pending.splice(idx, 1);
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_pending", JSON.stringify(pending))
        .run();

      await invalidateOwnerSessions(db, homestay.id);

      await logAction({
        db,
        action: 'homestay_rejected',
        admin: 'admin',
        details: `Rejected homestay "${homestay.name}" (ID: ${homestay.id})`,
        ip: clientIP,
        userId: homestay.ownerEmail,
        homestayId: homestay.id
      });

      return jsonResponse({ success: true }, 200, request);
    }

    // ---- Admin removeApprovedHomestay ----
    if (action === "removeApprovedHomestay" && body.id) {
      try {
        const isDemo = body.isDemo === true;

        const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
        let approved = [];
        if (approvedRes && approvedRes.data) {
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            return jsonResponse({ error: "Corrupt approved data" }, 500, request);
          }
        }

        const idx = approved.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return jsonResponse({ error: "Approved homestay not found" }, 404, request);
        }

        const removed = approved[idx];
        approved.splice(idx, 1);

        if (isDemo) {
          const demoRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_deleted_demo").first();
          let deletedDemo = [];
          if (demoRes && demoRes.data) {
            try { deletedDemo = JSON.parse(demoRes.data); } catch(e) {}
          }
          if (!Array.isArray(deletedDemo)) deletedDemo = [];
          if (!deletedDemo.includes(String(body.id))) {
            deletedDemo.push(String(body.id));
          }
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_deleted_demo", JSON.stringify(deletedDemo))
            .run();
        }

        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_approved", JSON.stringify(approved))
          .run();

        await invalidateOwnerSessions(db, removed.id);

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
        console.error("Remove homestay error:", removeErr.message);
        return jsonResponse({ error: "Remove failed. Please try again later." }, 500, request);
      }
    }

    // ---- Admin deleteGuest ----
    if (action === "deleteGuest") {
      const guestId = body.guestId ? String(body.guestId) : '';
      const email = body.email ? String(body.email).toLowerCase().trim() : '';

      if (!guestId && !email) {
        return jsonResponse({ error: 'Guest ID or email is required' }, 400, request);
      }

      const guestRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
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

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_guests", JSON.stringify(remainingGuests)).run();

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

    // ---- Admin deleteOwner ----
    if (action === "deleteOwner") {
      const ownerId = body.ownerId ? String(body.ownerId) : '';
      const email = body.email ? String(body.email).toLowerCase().trim() : '';
      const whatsapp = body.whatsapp ? String(body.whatsapp).replace(/[^0-9]/g, '') : '';

      if (!ownerId && !email && !whatsapp) {
        return jsonResponse({ error: 'Owner ID, email, or WhatsApp is required' }, 400, request);
      }

      const ownerRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_owners").first();
      let owners = [];
      if (ownerRes?.data) { try { owners = JSON.parse(ownerRes.data); } catch (_) {} }

      const deleted = owners.find(o =>
        (ownerId && String(o.id) === ownerId) ||
        (email && String(o.ownerEmail || '').toLowerCase().trim() === email) ||
        (whatsapp && String(o.whatsapp || '').replace(/[^0-9]/g, '') === whatsapp)
      );

      if (!deleted) {
        return jsonResponse({ error: 'Owner not found' }, 404, request);
      }

      const deletedId = String(deleted.id || '');
      const deletedEmail = String(deleted.ownerEmail || '').toLowerCase().trim();
      const deletedWa = String(deleted.whatsapp || '').replace(/[^0-9]/g, '');

      // 1. Remove from kd_owners
      const remainingOwners = owners.filter(o => {
        const sameId = deletedId && String(o.id || '') === deletedId;
        const sameEmail = deletedEmail && String(o.ownerEmail || '').toLowerCase().trim() === deletedEmail;
        const sameWa = deletedWa && String(o.whatsapp || '').replace(/[^0-9]/g, '') === deletedWa;
        return !sameId && !sameEmail && !sameWa;
      });

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_owners", JSON.stringify(remainingOwners)).run();

      // 2. Remove their homestays from kd_pending + kd_approved + kd_homestays
      const removedHomes = { pending: 0, approved: 0, mirror: 0 };
      for (const key of ['kd_pending', 'kd_approved', 'kd_homestays']) {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind(key).first();
        if (!r?.data) continue;
        let arr = [];
        try { arr = JSON.parse(r.data); } catch (_) { continue; }
        const before = arr.length;
        const filtered = arr.filter(h =>
          String(h.whatsapp || '').replace(/[^0-9]/g, '') !== deletedWa
        );
        const removedCount = before - filtered.length;
        if (key === 'kd_pending') removedHomes.pending = removedCount;
        else if (key === 'kd_approved') removedHomes.approved = removedCount;
        else removedHomes.mirror = removedCount;
        if (filtered.length !== before) {
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind(key, JSON.stringify(filtered)).run();
        }
      }

      await logAction({
        db,
        action: 'owner_deleted',
        admin: 'admin',
        details: `Deleted owner ${deletedEmail || deletedId} (WhatsApp ${deletedWa}); removed ${removedHomes.pending} pending, ${removedHomes.approved} approved`,
        ip: clientIP,
        userId: deletedId
      });

      return jsonResponse({
        success: true,
        deleted: { id: deletedId, email: deletedEmail, whatsapp: deletedWa },
        removedHomes
      }, 200, request);
    }

    // ---- Admin updateHomestays ----
    if (action === "updateHomestays") {
      const { approved, demoOverrides, demoBlocked, deletedDemo } = body;

      if (!Array.isArray(approved)) {
        return jsonResponse({ error: 'Invalid approved data' }, 400, request);
      }

      const stmts = [];
      stmts.push(db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_approved", JSON.stringify(approved)));

      if (demoOverrides !== undefined) {
        stmts.push(db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_demo_overrides", JSON.stringify(demoOverrides)));
      }
      if (demoBlocked !== undefined) {
        stmts.push(db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_demo_blocked", JSON.stringify(demoBlocked)));
      }
      if (deletedDemo !== undefined) {
        stmts.push(db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_deleted_demo", JSON.stringify(deletedDemo)));
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

    return jsonResponse({ success: true, message: "Synced" }, 200, request);

  } catch (err) {
    console.error('Bookings POST admin action error:', err.message);
    return jsonResponse({ error: 'An internal error occurred. Please try again later.' }, 500, request);
  }
}

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

  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
  const idx = bookings.findIndex(b => String(b.id) === String(id));
  if (idx === -1) {
    return jsonResponse({ error: 'Booking not found' }, 404, request);
  }
  const deleted = bookings[idx];
  bookings.splice(idx, 1);
  await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
    .bind('kd_bookings', JSON.stringify(bookings)).run();

  await logAction({
    db,
    action: 'booking_deleted_admin',
    admin: 'admin',
    details: `Deleted booking ${id} (${deleted.homestay})`,
    ip: getClientIP(request),
    userId: deleted.guestId,
    homestayId: deleted.homestayId
  });

  return jsonResponse({ success: true, deleted: deleted }, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
