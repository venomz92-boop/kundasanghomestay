// /api/availability - backward compat wrapper - now uses same store as bookings
// Fixed to prevent 404 that broke admin.html availability sync

export async function onRequestGet(context){
  const db = context.env.DB;
  const kv = context.env.KD_DATA;
  try{
    let availability = {};
    let bookings = [];
    if(db){
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      try{ const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first(); if(r) availability = JSON.parse(r.data); }catch(e){}
      try{ const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first(); if(r2) bookings = JSON.parse(r2.data); }catch(e){}
    } else if(kv){
      availability = await kv.get("kd_availability", {type:"json"}) || {};
      bookings = await kv.get("kd_bookings", {type:"json"}) || [];
    }
    return new Response(JSON.stringify({ availability, bookings }), { headers: { ...cors(), "Content-Type":"application/json"} });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message, availability: {} }), { status:500, headers: cors() });
  }
}

export async function onRequestPost(context){
  try{
    const body = await context.request.json();
    const db = context.env.DB;
    const kv = context.env.KD_DATA;
    let availability = body.availability || body;
    if(db){
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(availability)).run();
    } else if(kv){
      await kv.put("kd_availability", JSON.stringify(availability));
    }
    return new Response(JSON.stringify({ success:true, availability }), { headers: { ...cors(), "Content-Type":"application/json"} });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status:500, headers: cors() });
  }
}

function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: cors() }); }
