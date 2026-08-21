export async function onRequestGet(context) {
  const kv = context.env.KD_DATA;
  const db = context.env.DB;
  try {
    let bookings = [];
    let availability = {};
    let approved = [];
    let demoOverrides = {};
    let demoBlocked = {};
    let deletedDemo = [];
    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first(); if (r) bookings = JSON.parse(r.data); } catch(e) {}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first(); if (r) availability = JSON.parse(r.data); } catch(e) {}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first(); if (r) approved = JSON.parse(r.data); } catch(e) {}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_overrides").first(); if (r) demoOverrides = JSON.parse(r.data); } catch(e) {}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_blocked").first(); if (r) demoBlocked = JSON.parse(r.data); } catch(e) {}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_deleted_demo").first(); if (r) deletedDemo = JSON.parse(r.data); } catch(e) {}
    } else if (kv) {
      bookings = await kv.get("kd_bookings", { type: "json" }) || [];
      availability = await kv.get("kd_availability", { type: "json" }) || {};
      approved = await kv.get("kd_approved", { type: "json" }) || [];
      demoOverrides = await kv.get("kd_demo_overrides", { type: "json" }) || {};
      demoBlocked = await kv.get("kd_demo_blocked", { type: "json" }) || {};
      deletedDemo = await kv.get("kd_deleted_demo", { type: "json" }) || [];
    } else {
      return new Response(JSON.stringify({ error: "No KV or D1 bound" }), { status: 500, headers: cors() });
    }
    return new Response(JSON.stringify({ bookings, availability, approved, demoOverrides, demoBlocked, deletedDemo }), { headers: { ...cors(), "Content-Type": "application/json" } });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message, bookings: [], availability: {} }), { status: 500, headers: cors() });
  }
}

export async function onRequestPost(context) {
  const kv = context.env.KD_DATA;
  const db = context.env.DB;
  try {
    const body = await context.request.json();
    let bookings = [];
    let availability = {};
    let approved = [];
    let demoOverrides = {};
    let demoBlocked = {};
    let deletedDemo = [];

    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first(); if(r) bookings = JSON.parse(r.data); } catch(e){}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first(); if(r) availability = JSON.parse(r.data); } catch(e){}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first(); if(r) approved = JSON.parse(r.data); } catch(e){}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_overrides").first(); if(r) demoOverrides = JSON.parse(r.data); } catch(e){}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_blocked").first(); if(r) demoBlocked = JSON.parse(r.data); } catch(e){}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_deleted_demo").first(); if(r) deletedDemo = JSON.parse(r.data); } catch(e){}
    } else if (kv) {
      bookings = await kv.get("kd_bookings", { type: "json" }) || [];
      availability = await kv.get("kd_availability", { type: "json" }) || {};
      approved = await kv.get("kd_approved", { type: "json" }) || [];
      demoOverrides = await kv.get("kd_demo_overrides", { type: "json" }) || {};
      demoBlocked = await kv.get("kd_demo_blocked", { type: "json" }) || {};
      deletedDemo = await kv.get("kd_deleted_demo", { type: "json" }) || [];
    }

    // --- HOMESTAY SYNC ---
    if (body.action === "updateHomestays") {
      if (body.approved !== undefined) approved = body.approved;
      if (body.demoOverrides !== undefined) demoOverrides = body.demoOverrides;
      if (body.demoBlocked !== undefined) demoBlocked = body.demoBlocked;
      if (body.deletedDemo !== undefined) deletedDemo = body.deletedDemo;
    } else if (body.action === "updateApproved") {
      approved = body.approved || body.data || [];
    } else if (body.action === "updateDemoOverrides") {
      demoOverrides = body.demoOverrides || body.data || {};
    } else if (body.action === "updateDemoBlocked") {
      demoBlocked = body.demoBlocked || body.data || {};
    } else if (body.action === "updateDeletedDemo") {
      deletedDemo = body.deletedDemo || body.data || [];
    } else if (body.action === "clearAll") {
      bookings = [];
      availability = {};
    } else if (body.action === "delete") {
      const id = body.id;
      const b = bookings.find(x => String(x.id) === String(id));
      bookings = bookings.filter(x => String(x.id) !== String(id));
      if (b && b.homestayId) {
        const hid = b.homestayId;
        const hname = b.homestay;
        const remaining = bookings.filter(bb => {
          if (String(bb.homestayId)===String(hid)) return true;
          if (hname && bb.homestay===hname) return true;
          return false;
        }).filter(bb => !String(bb.status||"").toLowerCase().includes("pending"));
        const rebuilt = [];
        remaining.forEach(bb => { if(bb.checkin && bb.checkout) rebuilt.push(...getDatesInRange(bb.checkin, bb.checkout)); });
        if(rebuilt.length===0){ delete availability[hid]; } else { availability[hid] = [...new Set(rebuilt)].sort(); }
      }
    } else if (body.action === "update") {
      const bookingData = body.booking || body;
      const targetId = String(bookingData.id || body.id || "");
      if (!targetId) return new Response(JSON.stringify({ error: "Missing id for update" }), { status: 400, headers: cors() });
      const idx = bookings.findIndex(x => String(x.id) === String(targetId));
      if (idx !== -1) {
        bookings[idx] = { ...bookings[idx], ...bookingData, date: bookings[idx].date || new Date().toISOString(), statusUpdated: new Date().toISOString() };
      } else if (bookingData.id) {
        bookings.push(bookingData);
      }
    } else if (body.action === "updateStatus") {
      const { id, status } = body;
      const bookingPatch = body.booking || {};
      const targetId = String(id || bookingPatch.id || "");
      if (!targetId) return new Response(JSON.stringify({ error: "Missing id for updateStatus" }), { status: 400, headers: cors() });
      const idx = bookings.findIndex(x => String(x.id) === String(targetId));
      if (idx === -1) return new Response(JSON.stringify({ error: "Not found: "+targetId }), { status: 404, headers: cors() });
      bookings[idx] = { ...bookings[idx], ...bookingPatch, status: status || bookingPatch.status || bookings[idx].status, statusUpdated: new Date().toISOString() };
    } else if (body.action === "updateAvailability" || body.availability) {
      if (body.availability && typeof body.availability === 'object') {
        availability = body.availability;
      }
    } else if (body.action === "updateDates") {
      const { id, checkin, checkout, nights, base, fee, total, youReceive, gatewayFee } = body;
      const idx = bookings.findIndex(x => String(x.id) === String(id));
      if (idx === -1) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors() });
      const old = bookings[idx];
      const oldDates = getDatesInRange(old.checkin, old.checkout);
      const newDates = getDatesInRange(checkin, checkout);
      const hid = old.homestayId;
      if (hid && availability[hid]) {
        const blockedWithoutOld = availability[hid].filter(d => !oldDates.includes(d));
        const conflict = newDates.filter(d => blockedWithoutOld.includes(d));
        if (conflict.length > 0) return new Response(JSON.stringify({ error: "Conflict: "+conflict.join(", ") }), { status: 409, headers: cors() });
      }
      if (hid) {
        if (!availability[hid]) availability[hid]=[];
        availability[hid]=availability[hid].filter(d=>!oldDates.includes(d));
        newDates.forEach(d=>{ if(!availability[hid].includes(d)) availability[hid].push(d); });
        availability[hid].sort();
      }
      bookings[idx] = { ...old, checkin, checkout, nights, base, fee, total, youReceive, gatewayFee, date: new Date().toISOString(), status: (old.status||"Paid")+" (Changed)", statusUpdated: new Date().toISOString() };
    } else {
      // CREATE NEW BOOKING
      const booking = body.booking || body;
      if (!booking.id) return new Response(JSON.stringify({ error: "Missing id" }), { status: 400, headers: cors() });
      const existingIdx = bookings.findIndex(x => String(x.id) === String(booking.id));
      if (existingIdx !== -1) {
        bookings[existingIdx] = { ...bookings[existingIdx], ...booking, statusUpdated: new Date().toISOString() };
      } else {
        if (!booking.youReceive) booking.youReceive = booking.fee || booking.base || 0;
        if (!booking.status) booking.status = "Paid - Awaiting Check-in";
        bookings.push(booking);
      }
      const isPending = String(booking.status||"").toLowerCase().includes("pending");
      if (!isPending) {
        const hid = booking.homestayId;
        if (hid) {
          if (!availability[hid]) availability[hid]=[];
          let dates = body.bookedDates; if(!Array.isArray(dates) || dates.length===0) dates = getDatesInRange(booking.checkin, booking.checkout);
          dates.forEach(d=>{ if(!availability[hid].includes(d)) availability[hid].push(d); });
          availability[hid] = [...new Set(availability[hid])].sort();
        }
      }
    }

    // --- FIXED: Only save keys that were actually changed to prevent race resurrection ---
    const isBookingsAction = ["delete","update","updateStatus","updateDates","clearAll",null,undefined].includes(body.action) || !body.action;
    const isAvailAction = ["delete","updateDates","updateAvailability","clearAll",null,undefined].includes(body.action) || body.availability;
    const isHomestayAction = ["updateHomestays","updateApproved","updateDemoOverrides","updateDemoBlocked","updateDeletedDemo"].includes(body.action);

    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      if (body.action === "updateHomestays") {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_approved", JSON.stringify(approved)).run();
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_overrides", JSON.stringify(demoOverrides)).run();
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_blocked", JSON.stringify(demoBlocked)).run();
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_deleted_demo", JSON.stringify(deletedDemo)).run();
      } else if (body.action === "updateApproved") {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_approved", JSON.stringify(approved)).run();
      } else if (body.action === "updateDemoOverrides") {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_overrides", JSON.stringify(demoOverrides)).run();
      } else if (body.action === "updateDemoBlocked") {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_blocked", JSON.stringify(demoBlocked)).run();
      } else if (body.action === "updateDeletedDemo") {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_deleted_demo", JSON.stringify(deletedDemo)).run();
      } else if (body.action === "updateAvailability") {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(availability)).run();
      } else {
        // bookings-related actions: delete, update, updateStatus, updateDates, clearAll, create
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(availability)).run();
      }
    } else if (kv) {
      if (body.action === "updateHomestays") {
        await kv.put("kd_approved", JSON.stringify(approved));
        await kv.put("kd_demo_overrides", JSON.stringify(demoOverrides));
        await kv.put("kd_demo_blocked", JSON.stringify(demoBlocked));
        await kv.put("kd_deleted_demo", JSON.stringify(deletedDemo));
      } else if (body.action === "updateApproved") {
        await kv.put("kd_approved", JSON.stringify(approved));
      } else if (body.action === "updateDemoOverrides") {
        await kv.put("kd_demo_overrides", JSON.stringify(demoOverrides));
      } else if (body.action === "updateDemoBlocked") {
        await kv.put("kd_demo_blocked", JSON.stringify(demoBlocked));
      } else if (body.action === "updateDeletedDemo") {
        await kv.put("kd_deleted_demo", JSON.stringify(deletedDemo));
      } else if (body.action === "updateAvailability") {
        await kv.put("kd_availability", JSON.stringify(availability));
      } else {
        await kv.put("kd_bookings", JSON.stringify(bookings));
        await kv.put("kd_availability", JSON.stringify(availability));
      }
    }

    return new Response(JSON.stringify({ success: true, bookings, availability, approved, demoOverrides, demoBlocked, deletedDemo }), { headers: { ...cors(), "Content-Type": "application/json" } });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors() });
  }
}

export async function onRequestDelete(context) {
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  if (!id) return new Response(JSON.stringify({ error: "Missing id" }), { status: 400, headers: cors() });
  const kv = context.env.KD_DATA;
  const db = context.env.DB;
  try {
    let bookings = []; 
    let availability = {};
    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first(); if(r && r.data) { const parsed = JSON.parse(r.data); if(Array.isArray(parsed)) bookings = parsed; } } catch(e){}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first(); if(r && r.data) { const parsed = JSON.parse(r.data); if(parsed && typeof parsed === 'object') availability = parsed; } } catch(e){}
    } else if (kv) {
      try { const b = await kv.get("kd_bookings", { type: "json" }); if(Array.isArray(b)) bookings = b; } catch(e){}
      try { const a = await kv.get("kd_availability", { type: "json" }); if(a && typeof a === 'object') availability = a; } catch(e){}
    }
    if(!Array.isArray(bookings)) bookings = [];
    const b = bookings.find(x => x && String(x.id) === String(id));
    bookings = bookings.filter(x => x && String(x.id) !== String(id));
    if (b && b.homestayId) {
      const hid = b.homestayId;
      const hname = b.homestay;
      const remaining = bookings.filter(bb => {
        if(!bb) return false;
        if (String(bb.homestayId)===String(hid)) return true;
        if (hname && bb.homestay===hname) return true;
        return false;
      }).filter(bb => !String(bb.status||"").toLowerCase().includes("pending"));
      const rebuilt = [];
      remaining.forEach(bb => { if(bb && bb.checkin && bb.checkout) rebuilt.push(...getDatesInRange(bb.checkin, bb.checkout)); });
      if(rebuilt.length===0){ delete availability[hid]; } else { availability[hid] = [...new Set(rebuilt)].sort(); }
    }
    if (db) {
      try { await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run(); } catch(e){ console.error("DB bookings save fail", e); }
      try { await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(availability)).run(); } catch(e){ console.error("DB avail save fail", e); }
    } else if (kv) {
      try { await kv.put("kd_bookings", JSON.stringify(bookings)); } catch(e){}
      try { await kv.put("kd_availability", JSON.stringify(availability)); } catch(e){}
    }
    return new Response(JSON.stringify({ success: true, bookings, availability, deletedId: id }), { headers: { ...cors(), "Content-Type": "application/json" } });
  } catch(e) {
    console.error("DELETE error", e);
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500, headers: cors() });
  }
}

function getDatesInRange(checkin, checkout) {
  if (!checkin || !checkout) return [];
  const dates = [];
  const start = new Date(checkin+"T00:00:00");
  const end = new Date(checkout+"T00:00:00");
  if (isNaN(start) || isNaN(end) || start >= end) return [];
  const cur = new Date(start);
  while (cur < end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth()+1).padStart(2,'0');
    const d = String(cur.getDate()).padStart(2,'0');
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate()+1);
  }
  return dates;
}
function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: cors() }); }
