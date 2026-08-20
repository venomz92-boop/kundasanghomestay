
// /api/bookings - Works with KV (KD_DATA) OR D1 (DB) - auto detects
// If you can't find KV, use D1: create D1 database named KD_DATA and bind as DB

export async function onRequestGet(context) {
  const kv = context.env.KD_DATA;
  const db = context.env.DB;
  try {
    let bookings = [];
    let availability = {};
    if (db) {
      // D1 version
      try {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        if (res) bookings = JSON.parse(res.data);
      } catch(e) {}
      try {
        const res2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
        if (res2) availability = JSON.parse(res2.data);
      } catch(e) {}
    } else if (kv) {
      bookings = await kv.get("kd_bookings", { type: "json" }) || [];
      availability = await kv.get("kd_availability", { type: "json" }) || {};
    } else {
      return new Response(JSON.stringify({ error: "No KV or D1 bound. Bind KD_DATA (KV) or DB (D1)", bookings: [], availability: {} }), { status: 500, headers: cors() });
    }
    return new Response(JSON.stringify({ bookings, availability }), { headers: { ...cors(), "Content-Type": "application/json" } });
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

    // Load current
    if (db) {
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first(); if(r) bookings = JSON.parse(r.data); } catch(e){}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first(); if(r) availability = JSON.parse(r.data); } catch(e){}
    } else if (kv) {
      bookings = await kv.get("kd_bookings", { type: "json" }) || [];
      availability = await kv.get("kd_availability", { type: "json" }) || {};
    }

    // DELETE action - REBUILD from remaining bookings (fixes leftover date bug)
    if (body.action === "delete") {
      const id = body.id;
      const b = bookings.find(x => String(x.id) === String(id));
      bookings = bookings.filter(x => String(x.id) !== String(id));
      if (b && b.homestayId) {
        const hid = b.homestayId;
        const hname = b.homestay;
        const remaining = bookings.filter(bb => String(bb.homestayId)===String(hid) || (hname && bb.homestay===hname));
        const rebuilt = [];
        remaining.forEach(bb => { if(bb.checkin && bb.checkout) rebuilt.push(...getDatesInRange(bb.checkin, bb.checkout)); });
        if(rebuilt.length===0){ delete availability[hid]; } else { availability[hid] = [...new Set(rebuilt)].sort(); }
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
      bookings[idx] = { ...old, checkin, checkout, nights, base, fee, total, youReceive, gatewayFee, date: new Date().toISOString(), status: (old.status||"Paid")+" (Changed)" };
    } else {
      // Add new booking
      const booking = body.booking || body;
      if (!booking.id) return new Response(JSON.stringify({ error: "Missing id" }), { status: 400, headers: cors() });
      bookings.push(booking);
      const hid = booking.homestayId;
      if (hid) {
        if (!availability[hid]) availability[hid]=[];
        const dates = body.bookedDates || getDatesInRange(booking.checkin, booking.checkout);
        dates.forEach(d=>{ if(!availability[hid].includes(d)) availability[hid].push(d); });
        availability[hid].sort();
      }
    }

    // Save
    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(availability)).run();
    } else if (kv) {
      await kv.put("kd_bookings", JSON.stringify(bookings));
      await kv.put("kd_availability", JSON.stringify(availability));
    }

    return new Response(JSON.stringify({ success: true, bookings, availability }), { headers: { ...cors(), "Content-Type": "application/json" } });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors() });
  }
}

export async function onRequestDelete(context) {
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  if (!id) return new Response(JSON.stringify({ error: "Missing id" }), { status: 400, headers: cors() });
  // reuse POST delete logic
  const kv = context.env.KD_DATA;
  const db = context.env.DB;
  try {
    let bookings = []; let availability = {};
    if (db) {
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first(); if(r) bookings = JSON.parse(r.data); } catch(e){}
      try { const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first(); if(r) availability = JSON.parse(r.data); } catch(e){}
    } else if (kv) {
      bookings = await kv.get("kd_bookings", { type: "json" }) || [];
      availability = await kv.get("kd_availability", { type: "json" }) || {};
    }
    const b = bookings.find(x => String(x.id) === String(id));
    bookings = bookings.filter(x => String(x.id) !== String(id));
    if (b && b.homestayId) {
      const hid = b.homestayId;
      const hname = b.homestay;
      const remaining = bookings.filter(bb => String(bb.homestayId)===String(hid) || (hname && bb.homestay===hname));
      const rebuilt = [];
      remaining.forEach(bb => { if(bb.checkin && bb.checkout) rebuilt.push(...getDatesInRange(bb.checkin, bb.checkout)); });
      if(rebuilt.length===0){ delete availability[hid]; } else { availability[hid] = [...new Set(rebuilt)].sort(); }
    }
    if (db) {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(availability)).run();
    } else if (kv) {
      await kv.put("kd_bookings", JSON.stringify(bookings));
      await kv.put("kd_availability", JSON.stringify(availability));
    }
    return new Response(JSON.stringify({ success: true, bookings, availability }), { headers: { ...cors(), "Content-Type": "application/json" } });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors() });
  }
}

function getDatesInRange(checkin, checkout) {
  if (!checkin || !checkout) return [];
  const dates = [];
  const start = new Date(checkin+"T00:00:00");
  const end = new Date(checkout+"T00:00:00");
  if (isNaN(start) || isNaN(end) || start >= end) return [];
  const cur = new Date(start);
  while (cur < end) { dates.push(cur.toISOString().split("T")[0]); cur.setDate(cur.getDate()+1); }
  return dates;
}
function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: cors() }); }
