// /api/pending - dedicated pending endpoint for multi-device sync

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

export async function onRequestGet(context){
  const { env } = context;
  const db = getDB(env);
  let pending = [];
  let guests = [];
  if(db){
    try{
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if(r && r.data) pending = JSON.parse(r.data);
      const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
      if(r2 && r2.data) guests = JSON.parse(r2.data);
    }catch(e){}
  }
  return new Response(JSON.stringify({ pending, count: pending.length, guests, guestsCount: guests.length, hasDB: !!db }), { status: 200, headers: corsHeaders() });
}

export async function onRequestPost(context){
  const { request, env } = context;
  const db = getDB(env);
  if(!db) return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
  try{
    const body = await request.json();
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    
    let response = { success: true };
    
    // Handle pending
    if(body.pending !== undefined || body.new || Array.isArray(body)){
      let existingPending = [];
      try{
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
        if(r && r.data) existingPending = JSON.parse(r.data);
      }catch(e){}
      
      let incoming = [];
      if(body.pending && Array.isArray(body.pending)) incoming = body.pending;
      else if(Array.isArray(body)) incoming = body;
      else if(body.new) incoming = [body.new];
      
      if(incoming.length === 0 && existingPending.length > 0 && !body.new){
        response.pending = { kept: true, count: existingPending.length };
      } else {
        const map = new Map();
        [...existingPending, ...incoming].forEach(h=>{ if(h && h.id) map.set(String(h.id), h); });
        if(body.new && body.new.id) map.set(String(body.new.id), body.new);
        const merged = [...map.values()];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(merged)).run();
        response.pending = { count: merged.length, merged: true };
      }
    }
    
    // Handle guests
    if(body.guests !== undefined || body.action === "updateGuests"){
      let existingGuests = [];
      try{
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
        if(r && r.data) existingGuests = JSON.parse(r.data);
      }catch(e){}
      
      let incomingGuests = body.guests || [];
      if(incomingGuests.length === 0 && existingGuests.length > 0){
        response.guests = { kept: true, count: existingGuests.length };
      } else {
        const map = new Map();
        [...existingGuests, ...incomingGuests].forEach(g=>{ if(g && (g.email || g.id)) map.set(String(g.email || g.id).toLowerCase(), g); });
        const merged = [...map.values()];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_guests", JSON.stringify(merged)).run();
        response.guests = { count: merged.length, merged: true };
      }
    }
    
    return new Response(JSON.stringify(response), { status: 200, headers: corsHeaders() });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions(){
  return new Response(null, { headers: corsHeaders() });
}
