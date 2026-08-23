// /api/bookings.js - FULLY FIXED: All admin actions sync to DB

function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expectedToken = env.ADMIN_TOKEN || "";
  if (!expectedToken) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: corsHeaders()
    });
  }
  const expected = "Bearer " + expectedToken;
  if (auth !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized - Token mismatch" }), {
      status: 401,
      headers: corsHeaders()
    });
  }
  return null;
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
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

// ========== GET - PUBLIC (no auth required) ==========
export async function onRequestGet(context) {
  const { env } = context;
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
    return new Response(JSON.stringify(data), { status: 200, headers: corsHeaders() });
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

  return new Response(JSON.stringify(data), { status: 200, headers: corsHeaders() });
}

// ========== POST ==========
export async function onRequestPost(context) {
  const { request, env } = context;
  
  const body = await request.json().catch(() => ({}));
  const action = body.action;

  // ============================================================
  // PUBLIC ACTIONS (no auth required)
  // ============================================================

  // 1. Create booking
  if (action === "createPublicBooking" && body.booking) {
    const booking = body.booking;
    const required = ['id', 'homestay', 'homestayId', 'checkin', 'checkout', 'guestEmail', 'guestName', 'total', 'base', 'fee'];
    for (const field of required) {
      if (booking[field] === undefined || booking[field] === null || booking[field] === '') {
        return new Response(JSON.stringify({ error: `Missing required field: ${field}` }), {
          status: 400,
          headers: corsHeaders()
        });
      }
    }
    const d1 = new Date(booking.checkin);
    const d2 = new Date(booking.checkout);
    if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
      return new Response(JSON.stringify({ error: "Invalid checkin/checkout dates" }), { status: 400, headers: corsHeaders() });
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(booking.guestEmail)) {
      return new Response(JSON.stringify({ error: "Invalid guest email" }), { status: 400, headers: corsHeaders() });
    }
    if (isNaN(booking.total) || isNaN(booking.base) || isNaN(booking.fee)) {
      return new Response(JSON.stringify({ error: "Invalid price fields" }), { status: 400, headers: corsHeaders() });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
    }
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    let existing = [];
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    if (r && r.data) existing = JSON.parse(r.data);
    const map = new Map();
    [...existing, booking].forEach(b => { if (b && b.id) map.set(String(b.id), b); });
    const merged = [...map.values()];
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(merged)).run();
    return new Response(JSON.stringify({ success: true, bookingId: booking.id }), { status: 200, headers: corsHeaders() });
  }

  // 2. Public update status (ToyyibPay webhook)
  if (action === "publicUpdateStatus" && body.id && body.status) {
    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
    }
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = [];
      if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
      const idx = bookings.findIndex(b => String(b.id) === String(body.id));
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Booking not found" }), { status: 404, headers: corsHeaders() });
      }
      bookings[idx].status = body.status;
      bookings[idx].statusUpdated = new Date().toISOString();
      if (body.toyyibpay_billcode) bookings[idx].toyyibpay_billcode = body.toyyibpay_billcode;
      if (body.toyyibpay_transaction_id) bookings[idx].toyyibpay_transaction_id = body.toyyibpay_transaction_id;
      if (body.toyyibpay_status_id) bookings[idx].toyyibpay_status_id = body.toyyibpay_status_id;
      if (body.paid_at) bookings[idx].paid_at = body.paid_at;
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();
      // Update availability
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
      return new Response(JSON.stringify({ success: true, booking: bookings[idx] }), {
        status: 200,
        headers: corsHeaders()
      });
    } catch(e) {
      console.error("❌ publicUpdateStatus error:", e.message);
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
    }
  }

  // ============================================================
  // ALL OTHER ACTIONS REQUIRE ADMIN AUTH
  // ============================================================
  const authError = verifyAdmin(request, env);
  if (authError) return authError;

  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
  }

  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // ===== 1. UPDATE DATES (Admin changes booking dates) =====
    if (action === "updateDates" && body.id) {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = [];
      if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
      const idx = bookings.findIndex(b => String(b.id) === String(body.id));
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Booking not found" }), { status: 404, headers: corsHeaders() });
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

      // Rebuild availability
      try {
        const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
        let availability = {};
        if (availRes && availRes.data) { try { availability = JSON.parse(availRes.data); } catch(e) {} }
        const booking = bookings[idx];
        if (booking.homestayId && booking.checkin && booking.checkout) {
          const allBookings = bookings.filter(b => String(b.homestayId) === String(booking.homestayId));
          const allDates = new Set();
          allBookings.forEach(b => {
            if (b.checkin && b.checkout) {
              const dates = getDatesInRange(b.checkin, b.checkout);
              dates.forEach(d => allDates.add(d));
            }
          });
          // Preserve manually blocked dates
          const homestayRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
          let homestays = [];
          if (homestayRes && homestayRes.data) { try { homestays = JSON.parse(homestayRes.data); } catch(e) {} }
          const homestay = homestays.find(h => String(h.id) === String(booking.homestayId));
          if (homestay && homestay.blockedDates) {
            homestay.blockedDates.forEach(d => allDates.add(d));
          }
          if (allDates.size === 0) {
            delete availability[booking.homestayId];
          } else {
            availability[booking.homestayId] = [...allDates].sort();
          }
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_availability", JSON.stringify(availability))
            .run();
        }
      } catch(e) { console.warn("Availability update failed:", e.message); }

      return new Response(JSON.stringify({ success: true, booking: bookings[idx] }), {
        status: 200,
        headers: corsHeaders()
      });
    }

    // ===== 2. APPROVE HOMESTAY =====
    if (action === "approveHomestay" && body.id) {
      // Get pending list
      const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      let pending = [];
      if (pendingRes && pendingRes.data) { try { pending = JSON.parse(pendingRes.data); } catch(e) {} }
      
      const idx = pending.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Pending homestay not found" }), { status: 404, headers: corsHeaders() });
      }
      
      const homestay = pending[idx];
      homestay.approved = true;
      homestay.verified = true;
      
      // Remove from pending
      pending.splice(idx, 1);
      
      // Get approved list
      const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let approved = [];
      if (approvedRes && approvedRes.data) { try { approved = JSON.parse(approvedRes.data); } catch(e) {} }
      
      approved.push(homestay);
      
      // Save both
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_pending", JSON.stringify(pending))
        .run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_approved", JSON.stringify(approved))
        .run();
      
      return new Response(JSON.stringify({ success: true, homestay }), {
        status: 200,
        headers: corsHeaders()
      });
    }

    // ===== 3. REJECT HOMESTAY =====
    if (action === "rejectHomestay" && body.id) {
      const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      let pending = [];
      if (pendingRes && pendingRes.data) { try { pending = JSON.parse(pendingRes.data); } catch(e) {} }
      
      const idx = pending.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Pending homestay not found" }), { status: 404, headers: corsHeaders() });
      }
      
      pending.splice(idx, 1);
      
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_pending", JSON.stringify(pending))
        .run();
      
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: corsHeaders()
      });
    }

    // ===== 4. REMOVE APPROVED HOMESTAY =====
    if (action === "removeApprovedHomestay" && body.id) {
      const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let approved = [];
      if (approvedRes && approvedRes.data) { try { approved = JSON.parse(approvedRes.data); } catch(e) {} }
      
      const idx = approved.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Approved homestay not found" }), { status: 404, headers: corsHeaders() });
      }
      
      const removed = approved[idx];
      approved.splice(idx, 1);
      
      // Also remove from demoBlocked if it's a demo
      if (body.isDemo) {
        const demoBlockedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_blocked").first();
        let demoBlocked = {};
        if (demoBlockedRes && demoBlockedRes.data) { try { demoBlocked = JSON.parse(demoBlockedRes.data); } catch(e) {} }
        if (demoBlocked[body.id]) delete demoBlocked[body.id];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_demo_blocked", JSON.stringify(demoBlocked))
          .run();
        
        const deletedDemoRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_deleted_demo").first();
        let deletedDemo = [];
        if (deletedDemoRes && deletedDemoRes.data) { try { deletedDemo = JSON.parse(deletedDemoRes.data); } catch(e) {} }
        if (!deletedDemo.includes(String(body.id))) {
          deletedDemo.push(String(body.id));
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_deleted_demo", JSON.stringify(deletedDemo))
            .run();
        }
      }
      
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_approved", JSON.stringify(approved))
        .run();
      
      return new Response(JSON.stringify({ success: true, removed }), {
        status: 200,
        headers: corsHeaders()
      });
    }

    // ===== 5. CLEAR ALL =====
    if (action === "clearAll") {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify([])).run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify({})).run();
      return new Response(JSON.stringify({ success: true, bookings: [] }), { status: 200, headers: corsHeaders() });
    }

    // ===== 6. UPDATE PENDING (bulk) =====
    if (action === "updatePending" || body.pending !== undefined) {
      let existingPending = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if (r && r.data) existingPending = JSON.parse(r.data);
      let incoming = body.pending || [];
      const map = new Map();
      [...existingPending, ...incoming].forEach(h => { if (h && h.id) map.set(String(h.id), h); });
      const merged = [...map.values()];
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(merged)).run();
    }

    // ===== 7. UPDATE GUESTS =====
    if (action === "updateGuests" || action === "overwriteGuests" || action === "banGuest" || body.guests !== undefined) {
      let existingGuests = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
      if (r && r.data) existingGuests = JSON.parse(r.data);
      let incomingGuests = body.guests || [];
      if (action === "overwriteGuests" || action === "deleteGuest") {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_guests", JSON.stringify(incomingGuests)).run();
      } else if (action === "banGuest" && body.email) {
        const email = String(body.email).toLowerCase();
        let banned = [];
        const rb = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
        if (rb && rb.data) banned = JSON.parse(rb.data);
        if (!banned.includes(email)) banned.push(email);
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_banned_guests", JSON.stringify(banned)).run();
      } else {
        const map = new Map();
        [...existingGuests, ...incomingGuests].forEach(g => { if (g && (g.email || g.id)) map.set(String(g.email || g.id).toLowerCase(), g); });
        const merged = [...map.values()];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_guests", JSON.stringify(merged)).run();
      }
    }

    // ===== 8. UPDATE HOMESTAYS =====
    if (action === "updateHomestays" || body.approved !== undefined) {
      if (body.approved !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_approved", JSON.stringify(body.approved)).run();
      }
      if (body.demoOverrides !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_overrides", JSON.stringify(body.demoOverrides)).run();
      }
      if (body.demoBlocked !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_blocked", JSON.stringify(body.demoBlocked)).run();
      }
      if (body.deletedDemo !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_deleted_demo", JSON.stringify(body.deletedDemo)).run();
      }
    }

    // ===== 9. UPDATE AVAILABILITY =====
    if (action === "updateAvailability" || body.availability !== undefined) {
      const avail = body.availability || body.availability;
      if (avail) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(avail)).run();
      }
    }

    // ===== 10. UPDATE BOOKINGS (bulk) =====
    if (action === "updateBookings" || body.bookings !== undefined) {
      const b = body.bookings || body.bookings;
      if (b && Array.isArray(b)) {
        let existing = [];
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        if (r && r.data) existing = JSON.parse(r.data);
        const map = new Map();
        [...existing, ...b].forEach(book => { if (book && book.id) map.set(String(book.id), book); });
        const merged = [...map.values()];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(merged)).run();
      }
    }

    // ===== 11. GENERIC FALLBACK (saves single booking) =====
    if (body.id && body.action !== "updateBookings" && body.action !== "createPublicBooking" && body.action !== "updateDates" && body.action !== "approveHomestay" && body.action !== "rejectHomestay" && body.action !== "removeApprovedHomestay") {
      let existing = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      if (r && r.data) existing = JSON.parse(r.data);
      const map = new Map();
      [...existing, body].forEach(b => { if (b && b.id) map.set(String(b.id), b); });
      const merged = [...map.values()];
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(merged)).run();
    }

    return new Response(JSON.stringify({ success: true, message: "Synced" }), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (err) {
    console.error("POST handler error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders() });
  }
}

// ========== DELETE - ADMIN AUTH REQUIRED ==========
export async function onRequestDelete(context) {
  const { request, env } = context;
  const authError = verifyAdmin(request, env);
  if (authError) return authError;
  
  const db = env.DB;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!db || !id) {
    return new Response(JSON.stringify({ success: true, message: "No action needed" }), { status: 200, headers: corsHeaders() });
  }
  try {
    let bookings = [];
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    if (r && r.data) bookings = JSON.parse(r.data);
    const toDelete = bookings.find(b => String(b.id) === String(id));
    bookings = bookings.filter(b => String(b.id) !== String(id));
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();

    if (toDelete) {
      let avail = {};
      const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
      if (r2 && r2.data) avail = JSON.parse(r2.data);
      const homestayId = toDelete.homestayId || toDelete.homestay || toDelete.homestay_id;
      if (homestayId) {
        // Rebuild availability from remaining bookings
        const remainingDates = new Set();
        bookings.filter(b =>
          String(b.homestayId) === String(homestayId) ||
          String(b.homestay) === String(homestayId)
        ).forEach(b => {
          (b.bookedDates || []).forEach(d => remainingDates.add(d));
          if (b.checkin && b.checkout) {
            try {
              const s = new Date(b.checkin);
              const e = new Date(b.checkout);
              for (let d = new Date(s); d < e; d.setDate(d.getDate() + 1)) {
                remainingDates.add(d.toISOString().split('T')[0]);
              }
            } catch (e) { console.error("Failed to parse dates:", e.message); }
          }
        });
        // Also preserve manually blocked dates
        try {
          const homestayRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
          let homestays = [];
          if (homestayRes && homestayRes.data) { try { homestays = JSON.parse(homestayRes.data); } catch(e) {} }
          const homestay = homestays.find(h => String(h.id) === String(homestayId));
          if (homestay && homestay.blockedDates) {
            homestay.blockedDates.forEach(d => remainingDates.add(d));
          }
        } catch(e) {}
        
        if (remainingDates.size === 0) {
          delete avail[homestayId];
        } else {
          avail[homestayId] = [...remainingDates];
        }
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(avail)).run();
      }
    }
    return new Response(JSON.stringify({ success: true, deleted: id }), { status: 200, headers: corsHeaders() });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}
