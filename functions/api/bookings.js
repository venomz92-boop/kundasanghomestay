// /api/bookings.js - OPTIMIZED (No separate availability writes)
import { corsHeaders, getClientIP, logAction, enforceHttps, validateCSRFToken, getCSRFToken } from './_utils.js';

function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expectedToken = env.ADMIN_TOKEN || "";
  if (!expectedToken) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
  const expected = "Bearer " + expectedToken;
  if (auth !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders(request)
    });
  }
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

// ========== GET - PUBLIC ==========
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  const db = env.DB;
  let data = {
    bookings: [],
    availability: {},
    approved: [],
    demoOverrides: {},
    demoBlocked: {},
    deletedDemo: [],
    pending: [],
    guests: [],
    bannedGuests: []
  };

  if (!db) {
    return new Response(JSON.stringify(data), { 
      status: 200, 
      headers: corsHeaders(request) 
    });
  }

  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    const keys = [
      "kd_bookings", "kd_approved",
      "kd_demo_overrides", "kd_demo_blocked", "kd_deleted_demo",
      "kd_pending", "kd_guests", "kd_banned_guests"
    ];
    // ✅ NOTE: kd_availability is NO LONGER READ - we compute from bookings
    for (const key of keys) {
      try {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind(key).first();
        if (r && r.data) {
          const parsed = JSON.parse(r.data);
          switch (key) {
            case "kd_bookings": data.bookings = parsed; break;
            case "kd_approved": data.approved = parsed; break;
            case "kd_demo_overrides": data.demoOverrides = parsed; break;
            case "kd_demo_blocked": data.demoBlocked = parsed; break;
            case "kd_deleted_demo": data.deletedDemo = parsed; break;
            case "kd_pending": data.pending = parsed; break;
            case "kd_guests": 
              if (Array.isArray(parsed)) {
                data.guests = parsed.map(g => {
                  const { password, salt, ...rest } = g;
                  return rest;
                });
              } else {
                data.guests = parsed;
              }
              break;
            case "kd_banned_guests": data.bannedGuests = parsed; break;
          }
        }
      } catch (e) {}
    }
  } catch (e) {}

  return new Response(JSON.stringify(data), { 
    status: 200, 
    headers: {
      ...corsHeaders(request),
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=60'
    }
  });
}

// ========== POST ==========
export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  const body = await request.json().catch(() => ({}));
  const action = body.action;
  const clientIP = getClientIP(request);

  // CSRF Validation
  const publicActions = ['createPublicBooking', 'publicUpdateStatus'];
  
  function validatePublicCSRF(request, body) {
    if (!publicActions.includes(body.action)) return null;
    const token = getCSRFToken(request);
    const guestId = body.booking?.guestId || body.guestId;
    if (!token || !guestId) {
      return new Response(JSON.stringify({ error: "Missing security token" }), {
        status: 403,
        headers: corsHeaders(request)
      });
    }
    if (!validateCSRFToken(token, guestId)) {
      return new Response(JSON.stringify({ error: "Invalid security token" }), {
        status: 403,
        headers: corsHeaders(request)
      });
    }
    return null;
  }

  // ========== PUBLIC ACTIONS ==========

  // 1. Create booking - OPTIMIZED: Only writes to kd_bookings
  if (action === "createPublicBooking" && body.booking) {
    const booking = body.booking;
    
    const csrfError = validatePublicCSRF(request, body);
    if (csrfError) return csrfError;
    
    const required = ['id', 'homestay', 'homestayId', 'checkin', 'checkout', 'guestEmail', 'guestName', 'total', 'base', 'fee'];
    for (const field of required) {
      if (booking[field] === undefined || booking[field] === null || booking[field] === '') {
        return new Response(JSON.stringify({ error: `Missing required field: ${field}` }), {
          status: 400,
          headers: corsHeaders(request)
        });
      }
    }
    const d1 = new Date(booking.checkin);
    const d2 = new Date(booking.checkout);
    if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
      return new Response(JSON.stringify({ error: "Invalid dates" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(booking.guestEmail)) {
      return new Response(JSON.stringify({ error: "Invalid guest email" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "DB not configured" }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      
      // Read existing bookings
      let existing = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      if (r && r.data) existing = JSON.parse(r.data);
      
      // Merge new booking
      const map = new Map();
      [...existing, booking].forEach(b => { if (b && b.id) map.set(String(b.id), b); });
      const merged = [...map.values()];
      
      // ✅ ONLY ONE WRITE - to kd_bookings (no separate availability write)
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(merged))
        .run();
      
      await logAction({
        db,
        action: 'booking_created',
        admin: 'guest',
        details: `Booking ${booking.id} created for ${booking.homestay}`,
        ip: clientIP,
        userId: booking.guestEmail,
        homestayId: booking.homestayId
      });
      
      return new Response(JSON.stringify({ success: true, bookingId: booking.id }), { 
        status: 200, 
        headers: corsHeaders(request) 
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Database error: " + e.message }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }
  }

  // 2. Public update status (cancellation) - OPTIMIZED: Only writes to kd_bookings
  if (action === "publicUpdateStatus" && body.id && body.status) {
    const csrfError = validatePublicCSRF(request, body);
    if (csrfError) return csrfError;
    
    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "DB not configured" }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = [];
      if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
      const idx = bookings.findIndex(b => String(b.id) === String(body.id));
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Booking not found" }), { 
          status: 404, 
          headers: corsHeaders(request) 
        });
      }
      bookings[idx].status = body.status;
      bookings[idx].statusUpdated = new Date().toISOString();
      if (body.toyyibpay_billcode) bookings[idx].toyyibpay_billcode = body.toyyibpay_billcode;
      if (body.toyyibpay_transaction_id) bookings[idx].toyyibpay_transaction_id = body.toyyibpay_transaction_id;
      if (body.paid_at) bookings[idx].paid_at = body.paid_at;

      // ✅ ONLY ONE WRITE - to kd_bookings (availability is computed on read)
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();
      
      await logAction({
        db,
        action: 'booking_status_updated',
        admin: 'webhook',
        details: `Booking ${body.id} status → ${body.status}`,
        ip: clientIP,
        userId: bookings[idx].guestEmail,
        homestayId: bookings[idx].homestayId
      });
      
      return new Response(JSON.stringify({ success: true, booking: bookings[idx] }), {
        status: 200,
        headers: corsHeaders(request)
      });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }
  }

  // ========== ALL OTHER ACTIONS REQUIRE ADMIN AUTH ==========
  const authError = verifyAdmin(request, env);
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
        return new Response(JSON.stringify({ error: "Booking not found" }), { 
          status: 404, 
          headers: corsHeaders(request) 
        });
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
      
      return new Response(JSON.stringify({ success: true, booking: bookings[idx] }), {
        status: 200,
        headers: corsHeaders(request)
      });
    }

    // ===== APPROVE HOMESTAY =====
    if (action === "approveHomestay" && body.id) {
      const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      let pending = [];
      if (pendingRes && pendingRes.data) { try { pending = JSON.parse(pendingRes.data); } catch(e) {} }
      const idx = pending.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Pending homestay not found" }), { 
          status: 404, 
          headers: corsHeaders(request) 
        });
      }
      const homestay = pending[idx];
      homestay.approved = true;
      homestay.verified = true;
      pending.splice(idx, 1);
      const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let approved = [];
      if (approvedRes && approvedRes.data) { try { approved = JSON.parse(approvedRes.data); } catch(e) {} }
      approved.push(homestay);
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_pending", JSON.stringify(pending))
        .run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_approved", JSON.stringify(approved))
        .run();
      
      await logAction({
        db,
        action: 'homestay_approved',
        admin: 'admin',
        details: `Approved homestay "${homestay.name}" (ID: ${homestay.id}) by ${homestay.ownerName}`,
        ip: clientIP,
        userId: homestay.ownerEmail,
        homestayId: homestay.id
      });
      
      return new Response(JSON.stringify({ success: true, homestay }), {
        status: 200,
        headers: corsHeaders(request)
      });
    }

    // ===== REJECT HOMESTAY =====
    if (action === "rejectHomestay" && body.id) {
      const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      let pending = [];
      if (pendingRes && pendingRes.data) { try { pending = JSON.parse(pendingRes.data); } catch(e) {} }
      const idx = pending.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Pending homestay not found" }), { 
          status: 404, 
          headers: corsHeaders(request) 
        });
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
      
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: corsHeaders(request)
      });
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
      
      return new Response(JSON.stringify({ success: true }), { 
        status: 200, 
        headers: corsHeaders(request) 
      });
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

    return new Response(JSON.stringify({ success: true, message: "Synced" }), {
      status: 200,
      headers: corsHeaders(request)
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

// ========== DELETE ==========
export async function onRequestDelete({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  const authError = verifyAdmin(request, env);
  if (authError) return authError;
  
  const db = env.DB;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const clientIP = getClientIP(request);
  
  if (!db || !id) {
    return new Response(JSON.stringify({ success: true }), { 
      status: 200, 
      headers: corsHeaders(request) 
    });
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
    
    return new Response(JSON.stringify({ success: true, deleted: id }), { 
      status: 200, 
      headers: corsHeaders(request) 
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

// ===== BATCH UPDATE =====
if (action === "batchUpdate" && body.updates && Array.isArray(body.updates)) {
  for (const update of body.updates) {
    if (update.key && update.data) {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind(update.key, JSON.stringify(update.data))
        .run();
    }
  }
  return new Response(JSON.stringify({ success: true, count: body.updates.length }), {
    status: 200,
    headers: corsHeaders(request)
  });
}
