// /api/bookings - with PENDING SYNC FIX
// Handles bookings + pending homestays for multi-device sync

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
    pending: [] // <-- ADDED
  };

  if (db) {
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      
      const keys = ["kd_bookings", "kd_availability", "kd_approved", "kd_demo_overrides", "kd_demo_blocked", "kd_deleted_demo", "kd_pending"];
      for (const key of keys) {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind(key).first();
        if (r) {
          try {
            const parsed = JSON.parse(r.data);
            if (key === "kd_bookings") data.bookings = parsed;
            else if (key === "kd_availability") data.availability = parsed;
            else if (key === "kd_approved") data.approved = parsed;
            else if (key === "kd_demo_overrides") data.demoOverrides = parsed;
            else if (key === "kd_demo_blocked") data.demoBlocked = parsed;
            else if (key === "kd_deleted_demo") data.deletedDemo = parsed;
            else if (key === "kd_pending") data.pending = parsed;
          } catch(e){}
        }
      }
    } catch(e) {
      console.error("DB read error", e);
    }
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;
  
  try {
    const body = await request.json();
    const { action, pending, bookings, availability, approved, demoOverrides, demoBlocked, deletedDemo } = body;

    if (!db) {
      return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // Handle pending sync
    if (action === "updatePending" || pending !== undefined) {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(pending || [])).run();
      console.log("Pending updated:", (pending||[]).length);
    }

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

    if (action === "updateAvailability" || availability !== undefined) {
      const avail = availability || body.availability;
      if (avail) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(avail)).run();
      }
    }

    if (action === "updateBookings" || bookings !== undefined) {
      const b = bookings || body.bookings;
      if (b) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(b)).run();
      }
    }

    // Handle single booking
    if (body.id && body.checkin) {
      // It's a booking
      let existing = [];
      try {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        if (r) existing = JSON.parse(r.data);
      } catch(e){}
      existing.push(body);
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(existing)).run();
    }

    // Handle single new pending homestay
    if (body.new && !pending) {
      let existingPending = [];
      try {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
        if (r) existingPending = JSON.parse(r.data);
      } catch(e){}
      existingPending.push(body.new);
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(existingPending)).run();
    }

    return new Response(JSON.stringify({ success: true, message: "Synced" }), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (db && id) {
    try {
      let bookings = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      if (r) bookings = JSON.parse(r.data);
      bookings = bookings.filter(b => String(b.id) !== String(id));
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
    } catch(e){}
  }

  return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders() });
}

function corsHeaders(){
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
}

export async function onRequestOptions(){
  return new Response(null, { headers: corsHeaders() });
}
