// /api/bookings.js - with checkinCode, email sending, per‑room availability, optimistic locking, and room images
import { corsHeaders, getClientIP, logAction, enforceHttps, validateCSRFToken, getCSRFToken, getGuestSession, getAdminToken, jsonResponse, parseJSONSafely } from './_utils.js';

const MAX_NIGHTS = 60;
const DEFAULT_PAGE_SIZE = 50;

// ===== Helper: getDatesInRange =====
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

// ===== verifyAdmin =====
async function verifyAdmin(request, env) {
  const auth = await getAdminToken(request);
  if (!env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers: corsHeaders(request) });
  if (auth !== env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders(request) });
  return null;
}

// ===== requireGuest =====
async function requireGuest(request, env, body) {
  const session = await getGuestSession(request, env);
  if (!session || session.type !== 'guest') return { error: jsonResponse({ error: 'Authentication required' }, 401, request) };
  const guestId = body?.booking?.guestId || body?.guestId;
  if (guestId && String(guestId) !== String(session.userId)) return { error: jsonResponse({ error: 'Guest identity mismatch' }, 403, request) };
  const csrf = getCSRFToken(request);
  if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) return { error: jsonResponse({ error: 'Invalid security token' }, 403, request) };
  return { session };
}

// ===== Send booking confirmation email with check‑in code =====
async function sendBookingEmail(guestEmail, guestName, bookingId, homestayName, checkin, checkout, nights, total, checkinCode, env) {
  const html = `
    <h2>Hello ${guestName || 'Guest'},</h2>
    <p>Your booking at <strong>${homestayName}</strong> is confirmed!</p>
    <p><strong>Booking ID:</strong> ${bookingId}</p>
    <p><strong>Check‑in:</strong> ${checkin}</p>
    <p><strong>Check‑out:</strong> ${checkout}</p>
    <p><strong>Nights:</strong> ${nights}</p>
    <p><strong>Total Paid:</strong> RM ${total.toFixed(2)}</p>
    <p style="font-size:20px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
      🏔️ Your 6‑digit check‑in code: <span style="color:#0F382E;">${checkinCode}</span>
    </p>
    <p><strong>Please keep this code safe.</strong> You will need to share it with the host when you arrive. Do not share it with anyone else.</p>
    <p>If you have any questions, please contact us.</p>
    <p>— Kundasang Homestay Team</p>
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
          to: guestEmail,
          subject: 'Booking Confirmed – Your Check‑in Code',
          html
        })
      });
      return r.ok;
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: guestEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Booking Confirmed – Your Check‑in Code',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return r.ok;
    }
  } catch (e) {
    console.error('Booking email error:', e.message);
  }
  return false;
}

// ========== GET ==========
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT, version INTEGER DEFAULT 0)').run();

    const guestSession = await getGuestSession(request, env);
    const adminToken = await getAdminToken(request);
    const isAdmin = adminToken && adminToken === env.ADMIN_TOKEN;

    const keys = ['kd_bookings', 'kd_approved', 'kd_pending', 'kd_guests',
                  'kd_banned_guests', 'kd_demo_overrides', 'kd_demo_blocked', 'kd_deleted_demo'];
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
    const bannedGuests = dataMap['kd_banned_guests'];
    const demoOverrides = dataMap['kd_demo_overrides'];
    const demoBlocked = dataMap['kd_demo_blocked'];
    const deletedDemo = dataMap['kd_deleted_demo'];

    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const limit = parseInt(url.searchParams.get('limit')) || DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * limit;

    // ===== ADMIN =====
    if (isAdmin) {
      const paginated = bookings.slice(offset, offset + limit);
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
        guests: guests.map(g => { const { password, salt, ...safe } = g; return safe; }),
        bannedGuests
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

    // ===== GUEST =====
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

    // ===== PUBLIC VIEW =====
    const availability = {};
    for (const h of approved) {
      const homestayId = String(h.id);
      availability[homestayId] = bookings
        .filter(b => String(b.homestayId) === homestayId && !/cancelled|failed|expired/i.test(String(b.status || '')))
        .flatMap(b => getDatesInRange(b.checkin, b.checkout));
    }

    return jsonResponse({ approved, availability }, 200, request, {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
    });

  } catch (e) {
    console.error('Bookings GET error:', e.message, e.stack);
    return jsonResponse({ error: 'Failed to load bookings', details: e.message }, 500, request);
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

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT, version INTEGER DEFAULT 0)').run();

    const getWithVersion = async key => {
      const r = await db.prepare('SELECT data, version FROM store WHERE key=?').bind(key).first();
      try { return { data: r?.data ? JSON.parse(r.data) : [], version: r?.version || 0 }; } catch(_) { return { data: [], version: 0 }; }
    };

    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      try {
        const approvedData = await getWithVersion('kd_approved');
        const bookingsData = await getWithVersion('kd_bookings');
        const guestsData = await getWithVersion('kd_guests');

        const approved = approvedData.data;
        const bookings = bookingsData.data;
        const guests = guestsData.data;
        const currentVersion = bookingsData.version;

        const guest = guests.find(g => String(g.id) === String(auth.session.userId));
        const homestay = approved.find(h => String(h.id) === String(incoming.homestayId) && (h.approved === true || h.verified === true));
        if (!guest || !homestay) return jsonResponse({ error: 'Guest or homestay not found' }, 404, request);

        const rooms = homestay.rooms || [];
        let selectedRoom = null;
        if (incoming.roomId) {
          selectedRoom = rooms.find(r => r.id === incoming.roomId);
          if (!selectedRoom) return jsonResponse({ error: 'Selected room not found' }, 400, request);
        }
        const ownerPrice = selectedRoom ? parseFloat(selectedRoom.price) : homestay.ownerPrice;
        if (!Number.isFinite(ownerPrice) || ownerPrice <= 0) {
          return jsonResponse({ error: 'Homestay price is not configured correctly' }, 500, request);
        }

        const ci = String(incoming.checkin || ''), co = String(incoming.checkout || '');
        const d1 = new Date(ci+'T00:00:00'), d2 = new Date(co+'T00:00:00');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ci) || !/^\d{4}-\d{2}-\d{2}$/.test(co) || isNaN(d1) || isNaN(d2) || d1 >= d2) {
          return jsonResponse({ error: 'Invalid dates' }, 400, request);
        }
        const nights = Math.round((d2-d1)/86400000);
        if (nights < 1) return jsonResponse({ error: 'Booking must be at least 1 night' }, 400, request);
        if (nights > MAX_NIGHTS) return jsonResponse({ error: `Maximum booking is ${MAX_NIGHTS} nights` }, 400, request);
        const today = new Date(); today.setHours(0,0,0,0);
        if (d1 < today) return jsonResponse({ error: 'Cannot book past dates' }, 400, request);

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

        const homestayBlocked = new Set((homestay.blockedDates || []).map(String));
        const requestedDates = getDatesInRange(ci, co);
        for (const ds of requestedDates) {
          if (homestayBlocked.has(ds)) {
            return jsonResponse({ error: `Selected dates are unavailable (${ds}) due to homestay block` }, 409, request);
          }
        }

        if (selectedRoom) {
          const roomBlocked = new Set((selectedRoom.blockedDates || []).map(String));
          for (const ds of requestedDates) {
            if (roomBlocked.has(ds)) {
              return jsonResponse({ error: `Room "${selectedRoom.name}" is blocked on ${ds}` }, 409, request);
            }
          }
        }

        const overlaps = bookings.some(b => {
          const pendingExpired = String(b.status||'') === 'Pending Payment' && b.date && Date.now() - Date.parse(b.date) > 15*60*1000;
          const isOwnPending = String(b.guestId) === String(guest.id) && b.status === 'Pending Payment';
          const roomMatch = selectedRoom ? String(b.roomId) === String(selectedRoom.id) : String(b.homestayId) === String(homestay.id);
          return roomMatch &&
                 !pendingExpired &&
                 !/cancelled|failed|expired/i.test(String(b.status||'')) &&
                 !isOwnPending &&
                 ci < String(b.checkout||'') &&
                 co > String(b.checkin||'');
        });
        if (overlaps) {
          return jsonResponse({ error: 'Selected dates are already booked for this room' }, 409, request);
        }

        const base = Math.round(ownerPrice * nights * 100) / 100;
        const fee = Math.round(base * 0.11 * 100) / 100;
        const gatewayFee = 1.00;
        const total = Math.round((base + fee + gatewayFee) * 100) / 100;
        let bookingId = String(incoming.id || '');
        if (!/^KDH-[A-Za-z0-9_-]{4,40}$/.test(bookingId) || bookings.some(b=>String(b.id)===bookingId)) {
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
          checkin: ci,
          checkout: co,
          nights,
          base,
          fee,
          gatewayFee,
          total,
          status: 'Pending Payment',
          date: new Date().toISOString(),
          checkinCode: checkinCode,
          roomId: selectedRoom ? selectedRoom.id : null,
          roomName: selectedRoom ? selectedRoom.name : null,
          roomImages: selectedRoom ? (selectedRoom.images || []) : []  // <-- Store room images
        };
        
        bookings.push(booking);
        const newData = JSON.stringify(bookings);
        const newVersion = currentVersion + 1;

        const updateStmt = await db.prepare(
          'UPDATE store SET data = ?, version = ? WHERE key = ? AND version = ?'
        ).bind(newData, newVersion, 'kd_bookings', currentVersion);

        const result = await updateStmt.run();

        if (result.changes === 0) {
          console.log(`🔄 Booking race condition detected. Retry attempt ${attempts} for ${bookingId}`);
          continue;
        }

        await sendBookingEmail(guest.email, guest.name, bookingId, homestay.name, ci, co, nights, total, checkinCode, env)
          .catch(e => console.warn('Email send failed:', e));

        try {
          const guestPhoneClean = String(guest.phone || '').replace(/[^0-9]/g, '');
          if (guestPhoneClean && guestPhoneClean.length >= 9) {
            let phone = guestPhoneClean;
            if (phone.startsWith('0')) phone = '60' + phone.substring(1);
            const msg = `*Kundasang Homestay Booking Confirmed!* 🏔️\n\nBooking ID: ${bookingId}\nHomestay: ${homestay.name}\nCheck-in: ${ci}\nCheck-out: ${co}\n\n*Your 6-digit check-in code:* ${checkinCode}\n\nPlease keep this code safe. You will need to share it with the host when you arrive. Do not share it with anyone else.`;
            fetch(`https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(msg)}`, { method: 'GET' }).catch(()=>{});
          }
        } catch (waError) { console.warn('WhatsApp notification failed:', waError); }

        await logAction({db,action:'booking_created',admin:'guest',details:`Booking ${booking.id} created; payment pending`,ip:getClientIP(request),userId:guest.id,homestayId:homestay.id});
        return jsonResponse({success:true, booking}, 200, request);

      } catch(e) {
        console.error('Create booking error:', e.message);
        return jsonResponse({ error: 'Could not create booking' }, 500, request);
      }
    }

    console.error('❌ Max retries exceeded for booking creation');
    return jsonResponse({ error: 'Booking system busy. Please try again in a moment.' }, 503, request);
  }

  if (action === "publicUpdateStatus" && body.id) {
    const auth = await requireGuest(request, env, body);
    if (auth.error) return auth.error;
    if (body.status !== 'Cancelled by Guest') return jsonResponse({ error: 'Guests may only cancel their own booking.' }, 403, request);
    const db = env.DB; if (!db) return jsonResponse({error:'DB not configured'},500,request);
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT, version INTEGER DEFAULT 0)').run();
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
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT, version INTEGER DEFAULT 0)").run();

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
      try {
        const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
        let pending = [];
        if (pendingRes && pendingRes.data) { 
          try { pending = JSON.parse(pendingRes.data); } catch(e) { 
            console.error("Failed to parse kd_pending:", e);
            return jsonResponse({ error: "Corrupt pending data" }, 500, request);
          }
        }
        const idx = pending.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return jsonResponse({ error: "Pending homestay not found" }, 404, request);
        }
        const homestay = pending[idx];
        
        const { icImage, icOriginalName, bankQRImage, bankQROriginalName, pbtLicense, ...safeHomestay } = homestay;
        safeHomestay.approved = true;
        safeHomestay.verified = true;
        pending.splice(idx, 1);
        
        const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
        let approved = [];
        if (approvedRes && approvedRes.data) { 
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            console.error("Failed to parse kd_approved:", e);
            return jsonResponse({ error: "Corrupt approved data" }, 500, request);
          }
        }
        approved.push(safeHomestay);
        
        const stmt1 = db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_pending", JSON.stringify(pending));
        const stmt2 = db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_approved", JSON.stringify(approved));
        await db.batch([stmt1, stmt2]);
        
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
        console.error("Approve homestay error:", approveErr.message, approveErr.stack);
        return jsonResponse({ error: "Approval failed: " + approveErr.message }, 500, request);
      }
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

    // ===== REMOVE APPROVED HOMESTAY =====
    if (action === "removeApprovedHomestay" && body.id) {
      try {
        const isDemo = body.isDemo === true;
        
        const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
        let approved = [];
        if (approvedRes && approvedRes.data) {
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            console.error("Failed to parse kd_approved:", e);
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
        console.error("Remove homestay error:", removeErr.message, removeErr.stack);
        return jsonResponse({ error: "Remove failed: " + removeErr.message }, 500, request);
      }
    }

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

    return jsonResponse({ success: true, message: "Synced" }, 200, request);

  } catch (err) {
    console.error('Bookings POST error:', err.message, err.stack);
    return jsonResponse({ error: 'An internal error occurred: ' + err.message }, 500, request);
  }
}

// ========== DELETE ==========
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
  await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT, version INTEGER DEFAULT 0)').run();

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
