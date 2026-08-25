// /api/bookings.js - DEBUG VERSION with CSRF protection
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
    return new Response(JSON.stringify({ error: "Unauthorized - Token mismatch" }), {
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

// Helper to add dates to availability (block)
async function addDatesToAvailability(db, homestayId, dates) {
  if (!homestayId || !dates || dates.length === 0) return;
  try {
    const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
    let availability = {};
    if (availRes && availRes.data) { try { availability = JSON.parse(availRes.data); } catch(e) {} }
    if (!availability[homestayId]) availability[homestayId] = [];
    const existing = new Set(availability[homestayId]);
    for (const d of dates) {
      if (!existing.has(d)) {
        availability[homestayId].push(d);
      }
    }
    availability[homestayId].sort();
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_availability", JSON.stringify(availability))
      .run();
  } catch(e) {
    console.error("❌ addDatesToAvailability error:", e.message);
  }
}

// Helper to remove dates from availability ONLY if no other booking uses them
async function removeDatesFromAvailability(db, homestayId, bookingId, dates) {
  if (!homestayId || !dates || dates.length === 0) return;
  try {
    // Fetch all bookings to check for overlaps
    const bookingsRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let allBookings = [];
    if (bookingsRes && bookingsRes.data) { try { allBookings = JSON.parse(bookingsRes.data); } catch(e) {} }
    
    // Collect all dates used by other bookings (excluding the one being cancelled)
    const usedDates = new Set();
    for (const b of allBookings) {
      if (String(b.id) === String(bookingId)) continue; // skip the current booking
      if (String(b.homestayId) === String(homestayId) && b.checkin && b.checkout) {
        const bDates = getDatesInRange(b.checkin, b.checkout);
        for (const d of bDates) usedDates.add(d);
      }
    }
    // Only remove dates that are NOT used by any other booking
    const toRemove = dates.filter(d => !usedDates.has(d));
    if (toRemove.length === 0) return;

    const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
    let availability = {};
    if (availRes && availRes.data) { try { availability = JSON.parse(availRes.data); } catch(e) {} }
    if (!availability[homestayId]) availability[homestayId] = [];
    availability[homestayId] = availability[homestayId].filter(d => !toRemove.includes(d));
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_availability", JSON.stringify(availability))
      .run();
  } catch(e) {
    console.error("❌ removeDatesFromAvailability error:", e.message);
  }
}

// ========== CSRF VALIDATION FOR PUBLIC ACTIONS ==========
// Public actions that modify data need CSRF protection
const publicActions = ['createPublicBooking', 'publicUpdateStatus'];

// Helper function to validate CSRF for public actions
function validatePublicCSRF(request, body, env) {
  // Only check public actions
  if (!publicActions.includes(body.action)) return null;
  
  const token = getCSRFToken(request);
  // Get guestId from the booking data
  const guestId = body.booking?.guestId || body.guestId;
  
  if (!token || !guestId) {
    return new Response(JSON.stringify({ 
      error: "Missing security token. Please refresh and try again." 
    }), {
      status: 403,
      headers: corsHeaders(request)
    });
  }
  
  if (!validateCSRFToken(token, guestId)) {
    return new Response(JSON.stringify({ 
      error: "Invalid security token. Please refresh and try again." 
    }), {
      status: 403,
      headers: corsHeaders(request)
    });
  }
  
  return null; // No error, validation passed
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
    console.error("No database configured");
    return new Response(JSON.stringify(data), { 
      status: 200, 
      headers: corsHeaders(request) 
    });
  }

  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    const keys = [
      "kd_bookings", "kd_availability", "kd_approved",
      "kd_demo_overrides", "kd_demo_blocked", "kd_deleted_demo",
      "kd_pending", "kd_guests", "kd_banned_guests"
    ];
    for (const key of keys) {
      try {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind(key).first();
        if (r && r.data) {
          const parsed = JSON.parse(r.data);
          switch (key) {
            case "kd_bookings": data.bookings = parsed; break;
            case "kd_availability": data.availability = parsed; break;
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
      } catch (e) { console.error(`Failed to read key ${key}:`, e.message); }
    }
  } catch (e) { console.error("DB read error:", e.message); }

  console.log("🔍 GET bookings returned:", data.bookings.length, "bookings");
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

  console.log("📥 POST /api/bookings - action:", action, "body:", JSON.stringify(body).slice(0, 200));

  // ========== PUBLIC ACTIONS ==========

  // 1. Create booking
  if (action === "createPublicBooking" && body.booking) {
    const booking = body.booking;
    
    // ✅ CSRF Validation
    const csrfError = validatePublicCSRF(request, body, env);
    if (csrfError) return csrfError;
    
    const required = ['id', 'homestay', 'homestayId', 'checkin', 'checkout', 'guestEmail', 'guestName', 'total', 'base', 'fee'];
    for (const field of required) {
      if (booking[field] === undefined || booking[field] === null || booking[field] === '') {
        console.error("❌ Missing required field:", field);
        return new Response(JSON.stringify({ error: `Missing required field: ${field}` }), {
          status: 400,
          headers: corsHeaders(request)
        });
      }
    }
    const d1 = new Date(booking.checkin);
    const d2 = new Date(booking.checkout);
    if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
      console.error("❌ Invalid dates:", booking.checkin, booking.checkout);
      return new Response(JSON.stringify({ error: "Invalid dates" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(booking.guestEmail)) {
      console.error("❌ Invalid guest email:", booking.guestEmail);
      return new Response(JSON.stringify({ error: "Invalid guest email" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    const db = env.DB;
    if (!db) {
      console.error("❌ DB not configured");
      return new Response(JSON.stringify({ error: "DB not configured" }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      let existing = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      if (r && r.data) existing = JSON.parse(r.data);
      console.log("📊 Existing bookings count:", existing.length);
      
      const map = new Map();
      [...existing, booking].forEach(b => { if (b && b.id) map.set(String(b.id), b); });
      const merged = [...map.values()];
      console.log("📊 Merged bookings count:", merged.length);
      
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(merged))
        .run();
      
      console.log("✅ Booking saved:", booking.id);

      // Block dates in availability
      const dates = getDatesInRange(booking.checkin, booking.checkout);
      if (dates.length > 0 && booking.homestayId) {
        await addDatesToAvailability(db, booking.homestayId, dates);
        console.log(`📅 Blocked ${dates.length} dates for homestay ${booking.homestayId}`);
      }
      
      // Audit log
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
      console.error("❌ Failed to save booking:", e.message, e.stack);
      return new Response(JSON.stringify({ error: "Database error: " + e.message }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }
  }

  // 2. Public update status (webhook / cancellation)
  if (action === "publicUpdateStatus" && body.id && body.status) {
    // ✅ CSRF Validation
    const csrfError = validatePublicCSRF(request, body, env);
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
      const oldStatus = bookings[idx].status;
      bookings[idx].status = body.status;
      bookings[idx].statusUpdated = new Date().toISOString();
      if (body.toyyibpay_billcode) bookings[idx].toyyibpay_billcode = body.toyyibpay_billcode;
      if (body.toyyibpay_transaction_id) bookings[idx].toyyibpay_transaction_id = body.toyyibpay_transaction_id;
      if (body.paid_at) bookings[idx].paid_at = body.paid_at;

      // If status is Cancelled, free the dates
      if (body.status.toLowerCase() === "cancelled") {
        const booking = bookings[idx];
        if (booking.homestayId && booking.checkin && booking.checkout) {
          const dates = getDatesInRange(booking.checkin, booking.checkout);
          if (dates.length > 0) {
            await removeDatesFromAvailability(db, booking.homestayId, booking.id, dates);
            console.log(`📅 Freed ${dates.length} dates for homestay ${booking.homestayId} due to cancellation`);
          }
        }
      }

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
      
      // Update availability for payments (already done in webhook, but keep for safety)
      if (body.status.toLowerCase().includes("paid") && !body.status.toLowerCase().includes("cancelled")) {
        try {
          const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
          let availability = {};
          if (availRes && availRes.data) { try { availability = JSON.parse(availRes.data); } catch(e) {} }
          const booking = bookings[idx];
          if (booking.homestayId && booking.checkin && booking.checkout) {
            if (!availability[booking.homestayId]) availability[booking.homestayId] = [];
            const dates = getDatesInRange(booking.checkin, booking.checkout);
            dates.forEach(d => {
              if (!availability[booking.homestayId].includes(d)) {
                availability[booking.homestayId].push(d);
              }
            });
            availability[booking.homestayId] = [...new Set(availability[booking.homestayId])].sort();
            await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
              .bind("kd_availability", JSON.stringify(availability))
              .run();
          }
        } catch(e) { console.warn("Availability update failed:", e.message); }
      }
      
      return new Response(JSON.stringify({ success: true, booking: bookings[idx] }), {
        status: 200,
        headers: corsHeaders(request)
      });
    } catch(e) {
      console.error("publicUpdateStatus error:", e);
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

    // ===== REMOVE APPROVED HOMESTAY =====
    if (action === "removeApprovedHomestay" && body.id) {
      const isDemoHomestay = body.isDemo === true;
      const removedName = body.name || 'Unknown';
      
      if (isDemoHomestay) {
        const deletedDemoRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_deleted_demo").first();
        let deletedDemo = [];
        if (deletedDemoRes && deletedDemoRes.data) { try { deletedDemo = JSON.parse(deletedDemoRes.data); } catch(e) {} }
        if (!deletedDemo.includes(String(body.id))) {
          deletedDemo.push(String(body.id));
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_deleted_demo", JSON.stringify(deletedDemo))
            .run();
        }
        const demoBlockedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_blocked").first();
        let demoBlocked = {};
        if (demoBlockedRes && demoBlockedRes.data) { try { demoBlocked = JSON.parse(demoBlockedRes.data); } catch(e) {} }
        if (demoBlocked[body.id]) {
          delete demoBlocked[body.id];
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_demo_blocked", JSON.stringify(demoBlocked))
            .run();
        }
        const demoOverridesRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_overrides").first();
        let demoOverrides = {};
        if (demoOverridesRes && demoOverridesRes.data) { try { demoOverrides = JSON.parse(demoOverridesRes.data); } catch(e) {} }
        if (demoOverrides[body.id]) {
          delete demoOverrides[body.id];
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_demo_overrides", JSON.stringify(demoOverrides))
            .run();
        }
        const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
        let availability = {};
        if (availRes && availRes.data) { try { availability = JSON.parse(availRes.data); } catch(e) {} }
        if (availability[body.id]) {
          delete availability[body.id];
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_availability", JSON.stringify(availability))
            .run();
        }
        
        await logAction({
          db,
          action: 'demo_homestay_removed',
          admin: 'admin',
          details: `Removed demo homestay ${removedName} (ID: ${body.id})`,
          ip: clientIP,
          homestayId: body.id
        });
        
        return new Response(JSON.stringify({ success: true, removed: { id: body.id, isDemo: true } }), {
          status: 200,
          headers: corsHeaders(request)
        });
      } else {
        const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
        let approved = [];
        if (approvedRes && approvedRes.data) { try { approved = JSON.parse(approvedRes.data); } catch(e) {} }
        const idx = approved.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return new Response(JSON.stringify({ error: "Approved homestay not found" }), { 
            status: 404, 
            headers: corsHeaders(request) 
          });
        }
        const removed = approved[idx];
        approved.splice(idx, 1);
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_approved", JSON.stringify(approved))
          .run();
        const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
        let availability = {};
        if (availRes && availRes.data) { try { availability = JSON.parse(availRes.data); } catch(e) {} }
        if (availability[body.id]) {
          delete availability[body.id];
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_availability", JSON.stringify(availability))
            .run();
        }
        
        await logAction({
          db,
          action: 'homestay_removed',
          admin: 'admin',
          details: `Removed homestay "${removed.name}" (ID: ${removed.id}) by ${removed.ownerName}`,
          ip: clientIP,
          userId: removed.ownerEmail,
          homestayId: removed.id
        });
        
        return new Response(JSON.stringify({ success: true, removed }), {
          status: 200,
          headers: corsHeaders(request)
        });
      }
    }

    // ===== CLEAR ALL =====
    if (action === "clearAll") {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify([]))
        .run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_availability", JSON.stringify({}))
        .run();
      
      await logAction({
        db,
        action: 'clear_all',
        admin: 'admin',
        details: 'Cleared all bookings and availability',
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
    if (action === "updateGuests" || action === "overwriteGuests" || action === "banGuest" || body.guests !== undefined) {
      let existingGuests = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
      if (r && r.data) existingGuests = JSON.parse(r.data);
      let incomingGuests = body.guests || [];
      if (action === "overwriteGuests" || action === "deleteGuest") {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_guests", JSON.stringify(incomingGuests))
          .run();
      } else if (action === "banGuest" && body.email) {
        const email = String(body.email).toLowerCase();
        let banned = [];
        const rb = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
        if (rb && rb.data) banned = JSON.parse(rb.data);
        if (!banned.includes(email)) banned.push(email);
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_banned_guests", JSON.stringify(banned))
          .run();
        
        await logAction({
          db,
          action: 'guest_banned',
          admin: 'admin',
          details: `Banned guest: ${email}`,
          ip: clientIP,
          userId: email
        });
      } else {
        const map = new Map();
        [...existingGuests, ...incomingGuests].forEach(g => { if (g && (g.email || g.id)) map.set(String(g.email || g.id).toLowerCase(), g); });
        const merged = [...map.values()];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_guests", JSON.stringify(merged))
          .run();
      }
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

    // ===== UPDATE AVAILABILITY =====
    if (action === "updateAvailability" || body.availability !== undefined) {
      const avail = body.availability || body.availability;
      if (avail) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_availability", JSON.stringify(avail))
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
    console.error("POST handler error:", err.message);
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
