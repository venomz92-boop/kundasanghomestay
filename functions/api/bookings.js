// /api/bookings - ROBUST VERSION with multi-DB binding support
// Handles bookings + pending + approved sync

function getDB(env){
  return env.DB || env.D1 || env.MY_DB || env.DATABASE || env.KUNDASANG_DB || env.STORE || null;
}

function corsHeaders(){
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  const db = getDB(env);
  let data = {
    bookings: [],
    availability: {},
    approved: [],
    demoOverrides: {},
    demoBlocked: {},
    deletedDemo: [],
    pending: [],
    _debug: { hasDB: !!db, envKeys: Object.keys(env).filter(k=>!k.toLowerCase().includes('secret') && !k.toLowerCase().includes('key')).slice(0,20) }
  };

  if (db) {
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      const keys = ["kd_bookings", "kd_availability", "kd_approved", "kd_demo_overrides", "kd_demo_blocked", "kd_deleted_demo", "kd_pending"];
      for (const key of keys) {
        try {
          const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind(key).first();
          if (r && r.data) {
            const parsed = JSON.parse(r.data);
            if (key === "kd_bookings") data.bookings = parsed;
            else if (key === "kd_availability") data.availability = parsed;
            else if (key === "kd_approved") data.approved = parsed;
            else if (key === "kd_demo_overrides") data.demoOverrides = parsed;
            else if (key === "kd_demo_blocked") data.demoBlocked = parsed;
            else if (key === "kd_deleted_demo") data.deletedDemo = parsed;
            else if (key === "kd_pending") data.pending = parsed;
          }
        } catch(e){ console.error("Parse error for", key, e); }
      }
    } catch(e) {
      data._debug.error = e.message;
      console.error("DB read error", e);
    }
  } else {
    data._debug.error = "No D1 binding found - tried DB, D1, MY_DB, DATABASE, KUNDASANG_DB, STORE";
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: corsHeaders()
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = getDB(env);
  
  try {
    const body = await request.json();
    const { action, pending, bookings, availability, approved, demoOverrides, demoBlocked, deletedDemo } = body;

    if (!db) {
      return new Response(JSON.stringify({ 
        error: "DB not configured - Add D1 binding named DB in Cloudflare Pages > Settings > Functions > D1 bindings",
        envKeys: Object.keys(env).filter(k=>!k.toLowerCase().includes('secret')).slice(0,20),
        receivedAction: action
      }), { status: 500, headers: corsHeaders() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    let saved = [];

    if (action === "updatePending" || pending !== undefined) {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(pending || [])).run();
      saved.push(`pending:${(pending||[]).length}`);
      console.log("Pending updated:", (pending||[]).length);
    }

    if (action === "updateHomestays" || approved !== undefined) {
      if (approved !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_approved", JSON.stringify(approved)).run();
        saved.push(`approved:${approved.length}`);
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
        saved.push("availability");
      }
    }

    if (action === "updateBookings" || bookings !== undefined) {
      const b = bookings || body.bookings;
      if (b) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(b)).run();
        saved.push(`bookings:${b.length}`);
      }
    }

    if (body.id && body.checkin && !action) {
      let existing = [];
      try {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        if (r) existing = JSON.parse(r.data);
      } catch(e){}
      existing.push(body);
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(existing)).run();
      saved.push("single-booking");
    }

    if (body.new && !pending && !action) {
      let existingPending = [];
      try {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
        if (r) existingPending = JSON.parse(r.data);
      } catch(e){}
      existingPending.push(body.new);
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(existingPending)).run();
      saved.push("single-pending");
    }

    return new Response(JSON.stringify({ success: true, message: "Synced: " + saved.join(", "), saved }), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (err) {
    console.error("POST error", err);
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const db = getDB(env);
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

export async function onRequestOptions(){
  return new Response(null, { headers: corsHeaders() });
}
