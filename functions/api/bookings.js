// /api/bookings.js - FULL PATCHED with removeApprovedHomestay & transaction safety
import { corsHeaders, getClientIP, logAction, enforceHttps, validateCSRFToken, getCSRFToken, getGuestSession, getAdminToken, jsonResponse } from './_utils.js';

const MAX_NIGHTS = 60;

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

// ========== CSRF Validation ==========
const publicActions = ['createPublicBooking', 'publicUpdateStatus'];

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
    if (isAdmin) {
      return jsonResponse({ bookings, approved: await get('kd_approved'), demoOverrides: await get('kd_demo_overrides'), demoBlocked: await get('kd_demo_blocked'), deletedDemo: await get('kd_deleted_demo'), pending: await get('kd_pending'), guests: (await get('kd_guests')).map(g => { const {password,salt,...safe}=g; return safe; }), bannedGuests: await get('kd_banned_guests') }, 200, request, {'Cache-Control':'no-store'});
    }
    if (guestSession && guestSession.type === 'guest') {
      const mine = bookings.filter(b => String(b.guestId) === String(guestSession.userId));
      return jsonResponse({ bookings: mine }, 200, request, {'Cache-Control':'no-store'});
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
  
  const body = await request.json().catch(() => ({}));
  const action = body.action;
  const clientIP = getClientIP(request);

  // ========== PUBLIC ACTIONS ==========

  // 1. Create booking - OPTIMIZED: Only writes to kd_bookings
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
      
      // ***** MAX NIGHTS & PAST DATE CHECKS *****
      const nights = Math.round((d2-d1)/86400000);
      if (nights < 1) return jsonResponse({ error: 'Booking must be at least 1 night' }, 400, request);
      if (nights > MAX_NIGHTS) return jsonResponse({ error: `Maximum booking is ${MAX_NIGHTS} nights` }, 400, request);
      const today = new Date(); today.setHours(0,0,0,0);
      if (d1 < today) return jsonResponse({ error: 'Cannot book past dates' }, 400, request);
      
      // Check if guest already has a pending booking for the same homestay and dates
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

      // ---- Check availability (excluding the guest's own pending bookings) ----
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
      
      // ***** USE TRANSACTION *****
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

  // 2. Public update status (cancellation)
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

  // ========== ALL OTHER ACTIONS REQUIRE ADMIN AUTH ==========
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "DB not configured" }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }

  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // ===== UPDATE DATES =====
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

    // ===== APPROVE HOMESTAY =====
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
      
      // Use transaction
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

    // ===== REJECT HOMESTAY =====
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

    // ===== REMOVE APPROVED HOMESTAY (NEW) =====
    if (action === "removeApprovedHomestay" && body.id) {
      const id = String(body.id);
      const isDemo = body.isDemo === true;

      // 1. Remove from approved list (if not demo)
      if (!isDemo) {
        const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
        let approved = [];
        if (approvedRes && approvedRes.data) { try { approved = JSON.parse(approvedRes.data); } catch(e) {} }
        const idx = approved.findIndex(h => String(h.id) === id);
        if (idx === -1) {
          return jsonResponse({ error: "Homestay not found in approved list" }, 404, request);
        }
        const removed = approved.splice(idx, 1)[0];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_approved", JSON.stringify(approved))
          .run();

        await logAction({
          db,
          action: 'homestay_removed',
          admin: 'admin',
          details: `Removed approved homestay "${removed.name}" (ID: ${id}) by ${removed.ownerName}`,
          ip: clientIP,
          userId: removed.ownerEmail,
          homestayId: id
        });

        return jsonResponse({ success: true, removed, message: `Homestay ${id} removed from approved list.` }, 200, request);
      }

      // 2. For demo homestays: add to deleted list and clean up overrides
      if (isDemo) {
        const deletedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_deleted_demo").first();
        let deletedDemo = [];
        if (deletedRes && deletedRes.data) { try { deletedDemo = JSON.parse(deletedRes.data); } catch(e) {} }
        if (!Array.isArray(deletedDemo)) deletedDemo = [];

        if (!deletedDemo.includes(id)) {
          deletedDemo.push(id);
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_deleted_demo", JSON.stringify(deletedDemo))
            .run();
        }

        const overridesRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_overrides").first();
        let demoOverrides = {};
        if (overridesRes && overridesRes.data) { try { demoOverrides = JSON.parse(overridesRes.data); } catch(e) {} }
        if (demoOverrides[id]) {
          delete demoOverrides[id];
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_demo_overrides", JSON.stringify(demoOverrides))
            .run();
        }

        await logAction({
          db,
          action: 'demo_homestay_removed',
          admin: 'admin',
          details: `Removed demo homestay ID ${id}`,
          ip: clientIP
        });

        return jsonResponse({ success: true, removed: { id }, message: `Demo homestay ${id} marked as deleted.` }, 200, request);
      }

      return jsonResponse({ error: "Invalid request: neither approved nor demo" }, 400, request);
    }

    // ===== CLEAR ALL =====
    if (action === "clearAll") {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify([]))
        .run();
      
      await logAction({
        db,
        action: 'clear_all',
        admin: 'admin',
        details: 'Cleared all bookings',
        ip: clientIP
      });
      
      return jsonResponse({ success: true }, 200, request);
    }

    // ===== UPDATE PENDING =====
    if (action === "updatePending" || body.pending !== undefined) {
      let existingPending = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if (r && r.data) existingPending = JSON.parse(r.data);
      let incoming = body.pending || [];
      const map = new Map();
      [...existingPending, ...incoming].forEach(h => { if (h && h.id) map.set(String(h.id), h); });
      const merged = [...map.values()];
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_pending", JSON.stringify(merged))
        .run();
    }

    // ===== DELETE GUEST =====
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

      const bannedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
      let banned = [];
      if (bannedRes?.data) { try { banned = JSON.parse(bannedRes.data); } catch (_) {} }
      if (!Array.isArray(banned)) banned = [];
      if (deletedEmail && !banned.includes(deletedEmail)) banned.push(deletedEmail);

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_guests", JSON.stringify(remainingGuests)).run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_banned_guests", JSON.stringify(banned)).run();

      await logAction({
        db,
        action: 'guest_deleted_and_banned',
        admin: 'admin',
        details: `Deleted and banned guest ${deletedEmail || deletedId}`,
        ip: clientIP,
        userId: deletedId || deletedEmail
      });

      return jsonResponse({
        success: true,
        deleted: { id: deletedId, email: deletedEmail },
        bannedGuests: banned
      }, 200, request);
    }

    // ===== UPDATE GUESTS =====
    if (action === "updateGuests" || action === "overwriteGuests" || body.guests !== undefined) {
      let existingGuests = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
      if (r && r.data) existingGuests = JSON.parse(r.data);
      let incomingGuests = body.guests || [];
      const map = new Map();
      [...existingGuests, ...incomingGuests].forEach(g => { if (g && (g.email || g.id)) map.set(String(g.email || g.id).toLowerCase(), g); });
      const merged = [...map.values()];
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_guests", JSON.stringify(merged))
        .run();
    }

    // ===== UPDATE HOMESTAYS =====
    if (action === "updateHomestays" || body.approved !== undefined) {
      if (body.approved !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_approved", JSON.stringify(body.approved))
          .run();
      }
      if (body.demoOverrides !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_demo_overrides", JSON.stringify(body.demoOverrides))
          .run();
      }
      if (body.demoBlocked !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_demo_blocked", JSON.stringify(body.demoBlocked))
          .run();
      }
      if (body.deletedDemo !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_deleted_demo", JSON.stringify(body.deletedDemo))
          .run();
      }
    }

    // ===== UPDATE BOOKINGS =====
    if (action === "updateBookings" || body.bookings !== undefined) {
      const b = body.bookings || body.bookings;
      if (b && Array.isArray(b)) {
        let existing = [];
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        if (r && r.data) existing = JSON.parse(r.data);
        const map = new Map();
        [...existing, ...b].forEach(book => { if (book && book.id) map.set(String(book.id), book); });
        const merged = [...map.values()];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_bookings", JSON.stringify(merged))
          .run();
      }
    }

    return jsonResponse({ success: true, message: "Synced" }, 200, request);

  } catch (err) {
    console.error('Bookings POST error:', err.message);
    return jsonResponse({ error: 'An internal error occurred. Please try again later.' }, 500, request);
  }
}

// ========== DELETE ==========
export async function onRequestDelete({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;
  
  const db = env.DB;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const clientIP = getClientIP(request);
  
  if (!db || !id) {
    return jsonResponse({ success: true }, 200, request);
  }
  try {
    let bookings = [];
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    if (r && r.data) bookings = JSON.parse(r.data);
    
    const deleted = bookings.find(b => String(b.id) === String(id));
    bookings = bookings.filter(b => String(b.id) !== String(id));
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_bookings", JSON.stringify(bookings))
      .run();
    
    await logAction({
      db,
      action: 'booking_deleted',
      admin: 'admin',
      details: `Deleted booking ${id}`,
      ip: clientIP,
      userId: deleted?.guestEmail,
      homestayId: deleted?.homestayId
    });
    
    return jsonResponse({ success: true, deleted: id }, 200, request);
  } catch (e) {
    return jsonResponse({ error: 'Failed to delete booking' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
