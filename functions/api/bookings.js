// /api/bookings.js - SECURE: GET now requires admin token

function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expectedToken = env.ADMIN_TOKEN || "secret";
  const expected = "Bearer " + expectedToken;
  
  console.log("🔐 Auth Check:");
  console.log("  Received:", auth);
  console.log("  Expected:", expected);
  console.log("  Match:", auth === expected);
  
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

// ========== GET - NOW REQUIRES AUTH ==========
export async function onRequestGet(context) {
  const { request, env } = context;
  
  // --- 🔒 ADDED AUTH CHECK ---
  const authError = verifyAdmin(request, env);
  if (authError) return authError;
  // ---------------------------

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
              // 🔒 REMOVE passwords from response
              if (Array.isArray(parsed)) {
                data.guests = parsed.map(g => {
                  const { password, ...rest } = g;
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

// ========== POST - Requires Auth ==========
export async function onRequestPost(context) {
  const { request, env } = context;
  
  // Check auth for POST requests
  const authError = verifyAdmin(request, env);
  if (authError) return authError;
  
  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
  }

  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    const body = await request.json();
    const { action, booking, bookings, availability, approved, demoOverrides, demoBlocked, deletedDemo, guests, pending } = body;

    // PUBLIC: create a pending booking without auth (used before payment)
    if (action === "createPublicBooking" && booking) {
      let existing = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      if (r && r.data) existing = JSON.parse(r.data);
      const map = new Map();
      [...existing, booking].forEach(b => { if (b && b.id) map.set(String(b.id), b); });
      const merged = [...map.values()];
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(merged)).run();
      return new Response(JSON.stringify({ success: true, bookingId: booking.id }), { status: 200, headers: corsHeaders() });
    }

    // --- CLEAR ALL ---
    if (action === "clearAll") {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify([])).run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify({})).run();
      return new Response(JSON.stringify({ success: true, bookings: [] }), { status: 200, headers: corsHeaders() });
    }

    // --- PENDING ---
    if (action === "updatePending" || pending !== undefined) {
      let existingPending = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if (r && r.data) existingPending = JSON.parse(r.data);
      let incoming = pending || [];
      const map = new Map();
      [...existingPending, ...incoming].forEach(h => { if (h && h.id) map.set(String(h.id), h); });
      const merged = [...map.values()];
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(merged)).run();
    }

    // --- GUESTS ---
    if (action === "updateGuests" || action === "overwriteGuests" || action === "banGuest" || guests !== undefined) {
      let existingGuests = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
      if (r && r.data) existingGuests = JSON.parse(r.data);
      let incomingGuests = guests || [];
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

    // --- HOMESTAYS (APPROVED/DEMO) ---
    if (action === "updateHomestays" || approved !== undefined) {
      if (approved !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_approved", JSON.stringify(approved)).run();
      }
      if (demoOverrides !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_overrides", JSON.stringify(demoOverrides)).run();
      }
      if (demoBlocked !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_blocked", JSON.stringify(demoBlocked)).run();
      }
      if (deletedDemo !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_deleted_demo", JSON.stringify(deletedDemo)).run();
      }
    }

    // --- AVAILABILITY ---
    if (action === "updateAvailability" || availability !== undefined) {
      const avail = availability || body.availability;
      if (avail) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(avail)).run();
      }
    }

    // --- BOOKINGS (BULK) ---
    if (action === "updateBookings" || bookings !== undefined) {
      const b = bookings || body.bookings;
      if (b && Array.isArray(b)) {
        let existing = [];
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        if (r && r.data) existing = JSON.parse(r.data);
        if (b.length === 0 && existing.length > 0) {
          console.log("Bookings empty, keeping existing:", existing.length);
        } else {
          const map = new Map();
          [...existing, ...b].forEach(book => { if (book && book.id) map.set(String(book.id), book); });
          const merged = [...map.values()];
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(merged)).run();
        }
      }
    }

    // --- SINGLE BOOKING (updateStatus, updateDates) ---
    if (body.id && body.action !== "updateBookings" && body.action !== "createPublicBooking") {
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

// ========== DELETE - Requires Auth ==========
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
