// /api/bookings.js - with pagination
import { corsHeaders, getClientIP, logAction, enforceHttps, validateCSRFToken, getCSRFToken, getGuestSession, getAdminToken, jsonResponse, parseJSONSafely } from './_utils.js';

const MAX_NIGHTS = 60;
const DEFAULT_PAGE_SIZE = 50;

async function verifyAdmin(request, env) {
  const auth = await getAdminToken(request);
  if (!auth || !env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders(request) });
  if (auth !== env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders(request) });
  return null;
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

async function requireGuest(request, env, body) {
  const session = await getGuestSession(request, env);
  if (!session || session.type !== 'guest') return { error: jsonResponse({ error: 'Authentication required' }, 401, request) };
  const guestId = body?.booking?.guestId || body?.guestId;
  if (guestId && String(guestId) !== String(session.userId)) return { error: jsonResponse({ error: 'Guest identity mismatch' }, 403, request) };
  const csrf = getCSRFToken(request);
  if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) return { error: jsonResponse({ error: 'Invalid security token' }, 403, request) };
  return { session };
}

// ========== GET ==========
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  const adminAuth = await verifyAdmin(request, env);
  const isAdmin = adminAuth === null;
  const guestSession = isAdmin ? null : await getGuestSession(request, env);
  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const get = async key => { const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first(); try { return r?.data ? JSON.parse(r.data) : []; } catch (_) { return []; } };
    const bookings = await get('kd_bookings');
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const limit = parseInt(url.searchParams.get('limit')) || DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * limit;

    if (isAdmin) {
      // For admin, return all data with pagination info
      const paginated = bookings.slice(offset, offset + limit);
      return jsonResponse({
        bookings: paginated,
        total: bookings.length,
        page,
        limit,
        totalPages: Math.ceil(bookings.length / limit),
        approved: await get('kd_approved'),
        demoOverrides: await get('kd_demo_overrides'),
        demoBlocked: await get('kd_demo_blocked'),
        deletedDemo: await get('kd_deleted_demo'),
        pending: await get('kd_pending'),
        guests: (await get('kd_guests')).map(g => { const {password,salt,...safe}=g; return safe; }),
        bannedGuests: await get('kd_banned_guests')
      }, 200, request, {'Cache-Control':'no-store'});
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
      }, 200, request, {'Cache-Control':'no-store'});
    }
    const approved = await get('kd_approved');
    const availability = {};
    for (const h of approved) {
      availability[String(h.id)] = bookings.filter(b => String(b.homestayId) === String(h.id) && !/cancelled|failed|expired/i.test(String(b.status||''))).flatMap(b => getDatesInRange(b.checkin,b.checkout));
    }
    return jsonResponse({ approved, availability }, 200, request, {'Cache-Control':'public, max-age=60, stale-while-revalidate=120'});
  } catch (e) {
    console.error('Bookings GET error:', e.message);
    return jsonResponse({ error: 'Failed to load bookings' }, 500, request);
  }
}

// ========== POST ==========
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
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
      const get = async key => { const r=await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first(); try{return r?.data?JSON.parse(r.data):[];}catch(_){return[];} };
      const approved = await get('kd_approved');
      const bookings = await get('kd_bookings');
      const guests = await get('kd_guests');
      const guest = guests.find(g => String(g.id) === String(auth.session.userId));
      const homestay = approved.find(h => String(h.id) === String(incoming.homestayId) && (h.approved === true || h.verified === true));
      if (!guest || !homestay) return jsonResponse({ error: 'Guest or homestay not found' }, 404, request);
      const ci = String(incoming.checkin || ''), co = String(incoming.checkout || '');
      const d1 = new Date(ci+'T00:00:00'), d2 = new Date(co+'T00:00:00');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ci) || !/^\d{4}-\d{2}-\d{2}$/.test(co) || isNaN(d1) || isNaN(d2) || d1 >= d2) return jsonResponse({ error: 'Invalid dates' }, 400, request);
      
      const nights = Math.round((d2-d1)/86400000);
      if (nights < 1) return jsonResponse({ error: 'Booking must be at least 1 night' }, 400, request);
      if (nights > MAX_NIGHTS) return jsonResponse({ error: `Maximum booking is ${MAX_NIGHTS} nights` }, 400, request);
      const today = new Date(); today.setHours(0,0,0,0);
      if (d1 < today) return jsonResponse({ error: 'Cannot book past dates' }, 400, request);
      
      // Existing pending check
      const existingPending = bookings.find(b =>
        String(b.guestId) === String(guest.id) &&
        String(b.homestayId) === String(homestay.id) &&
        b.checkin === ci &&
        b.checkout === co &&
        b.status === 'Pending Payment'
      );
      if (existingPending) {
        return jsonResponse({
          success: true,
          booking: existingPending,
          alreadyExists: true,
          message: 'You already have a pending booking for these dates. Please complete the payment.'
        }, 200, request);
      }

      // Availability
      const blocked = new Set((homestay.blockedDates || []).map(String));
      for (let i=0;i<nights;i++){ const d=new Date(d1); d.setDate(d.getDate()+i); const ds=d.toISOString().slice(0,10); if(blocked.has(ds)) return jsonResponse({ error: `Selected dates are unavailable (${ds})` }, 409, request); }
      
      const overlaps = bookings.some(b => {
        const pendingExpired = String(b.status||'') === 'Pending Payment' && b.date && Date.now() - Date.parse(b.date) > 15*60*1000;
        const isOwnPending = String(b.guestId) === String(guest.id) && b.status === 'Pending Payment';
        return String(b.homestayId) === String(homestay.id) &&
               !pendingExpired &&
               !/cancelled|failed|expired/i.test(String(b.status||'')) &&
               !isOwnPending &&
               ci < String(b.checkout||'') &&
               co > String(b.checkin||'');
      });
      if (overlaps) return jsonResponse({ error: 'Selected dates are no longer available' }, 409, request);

      const ownerPrice = Number(homestay.ownerPrice);
      if (!Number.isFinite(ownerPrice) || ownerPrice <= 0) return jsonResponse({ error: 'Homestay price is not configured correctly' }, 500, request);
      const base = Math.round(ownerPrice * nights * 100) / 100;
      const fee = Math.round(base * 0.11 * 100) / 100;
      const gatewayFee = 1.00;
      const total = Math.round((base + fee + gatewayFee) * 100) / 100;
      let bookingId = String(incoming.id || '');
      if (!/^KDH-[A-Za-z0-9_-]{4,40}$/.test(bookingId) || bookings.some(b=>String(b.id)===bookingId)) bookingId = `KDH-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
      const booking = {
        id: bookingId, homestay: homestay.name, homestayId: homestay.id, ownerWhatsapp: homestay.whatsapp || '',
        guestId: guest.id, guestName: guest.name, guestEmail: guest.email, guestPhone: guest.phone || '',
        checkin: ci, checkout: co, nights, base, fee, gatewayFee, total, status: 'Pending Payment', date: new Date().toISOString()
      };
      
      await db.prepare('BEGIN TRANSACTION').run();
      try {
        bookings.push(booking);
        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)').bind('kd_bookings',JSON.stringify(bookings)).run();
        await db.prepare('COMMIT').run();
      } catch (txError) {
        await db.prepare('ROLLBACK').run();
        throw txError;
      }
      
      await logAction({db,action:'booking_created',admin:'guest',details:`Booking ${booking.id} created; payment pending`,ip:clientIP,userId:guest.id,homestayId:homestay.id});
      return jsonResponse({success:true,booking},200,request);
    } catch(e){ console.error('Create booking error:',e.message); return jsonResponse({error:'Could not create booking'},500,request); }
  }

  if (action === "publicUpdateStatus" && body.id) {
    const auth = await requireGuest(request, env, body);
    if (auth.error) return auth.error;
    if (body.status !== 'Cancelled by Guest') return jsonResponse({ error: 'Guests may only cancel their own booking.' }, 403, request);
    const db = env.DB; if (!db) return jsonResponse({error:'DB not configured'},500,request);
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY,data TEXT)').run();
      const r=await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first(); let bookings=[]; try{if(r?.data)bookings=JSON.parse(r.data)}catch(_){}
      const idx=bookings.findIndex(b=>String(b.id)===String(body.id));
      if(idx<0)return jsonResponse({error:'Booking not found'},404,request);
      const b=bookings[idx];
      if(String(b.guestId)!==String(auth.session.userId))return jsonResponse({error:'Unauthorized'},403,request);
      if(/paid|completed/i.test(String(b.status||'')))return jsonResponse({error:'Paid bookings cannot be cancelled from the guest portal. Please contact support/host.'},400,request);
      bookings[idx]={...b,status:'Cancelled by Guest',statusUpdated:new Date().toISOString()};
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)').bind('kd_bookings',JSON.stringify(bookings)).run();
      await logAction({db,action:'booking_cancelled_by_guest',admin:'guest',details:`Booking ${b.id} cancelled by guest`,ip:clientIP,userId:b.guestId,homestayId:b.homestayId});
      return jsonResponse({success:true,booking:bookings[idx]},200,request);
    }catch(e){console.error('Guest cancellation error:',e.message);return jsonResponse({error:'Could not update booking'},500,request)}
  }

  // ========== ADMIN ACTIONS ==========
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders(request) });
  }

  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

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

    if (action === "approveHomestay" && body.id) {
      const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      let pending = [];
      if (pendingRes && pendingRes.data) { try { pending = JSON.parse(pendingRes.data); } catch(e) {} }
      const idx = pending.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return jsonResponse({ error: "Pending homestay not found" }, 404, request);
      }
      const homestay = pending[idx];
      homestay.approved = true;
      homestay.verified = true;
      pending.splice(idx, 1);
      const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let approved = [];
      if (approvedRes && approvedRes.data) { try { approved = JSON.parse(approvedRes.data); } catch(e) {} }
      approved.push(homestay);
      
      await db.prepare('BEGIN TRANSACTION').run();
      try {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_pending", JSON.stringify(pending))
          .run();
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_approved", JSON.stringify(approved))
          .run();
        await db.prepare('COMMIT').run();
      } catch (txError) {
        await db.prepare('ROLLBACK').run();
        throw txError;
      }
      
      await logAction({
        db,
        action: 'homestay_approved',
        admin: 'admin',
        details: `Approved homestay "${homestay.name}" (ID: ${homestay.id}) by ${homestay.ownerName}`,
        ip: clientIP,
        userId: homestay.ownerEmail,
        homestayId: homestay.id
      });
      
      return jsonResponse({ success: true, homestay }, 200, request);
    }

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

    // ... (rest of admin actions unchanged)
    // For brevity, I'm omitting the remaining admin actions (removeApprovedHomestay, clearAll, etc.)
    // They remain identical to your original. I'll include a placeholder comment.

    // ===== All other admin actions (same as before) =====
    // ... (keep your existing code for deleteGuest, updateGuests, updateHomestays, updateBookings, etc.)

    return jsonResponse({ success: true, message: "Synced" }, 200, request);

  } catch (err) {
    console.error('Bookings POST error:', err.message);
    return jsonResponse({ error: 'An internal error occurred. Please try again later.' }, 500, request);
  }
}

export async function onRequestDelete({ request, env }) {
  // ... (same as before)
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
