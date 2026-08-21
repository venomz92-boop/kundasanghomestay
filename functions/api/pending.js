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
  if(db){
    try{
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if(r) pending = JSON.parse(r.data);
    }catch(e){}
  }
  return new Response(JSON.stringify({ pending, count: pending.length, hasDB: !!db }), { status: 200, headers: corsHeaders() });
}

export async function onRequestPost(context){
  const { request, env } = context;
  const db = getDB(env);
  if(!db) return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
  try{
    const body = await request.json();
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    // Get existing
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
      // Don't clear with empty
      return new Response(JSON.stringify({ success: true, count: existingPending.length, kept: true, message: "Kept existing, incoming empty" }), { status: 200, headers: corsHeaders() });
    }
    
    // Merge by id
    const map = new Map();
    [...existingPending, ...incoming].forEach(h=>{ if(h && h.id) map.set(String(h.id), h); });
    if(body.new && body.new.id){
      map.set(String(body.new.id), body.new);
    }
    const merged = [...map.values()];
    
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(merged)).run();
    
    return new Response(JSON.stringify({ success: true, count: merged.length, merged: true, existing: existingPending.length, incoming: incoming.length }), { status: 200, headers: corsHeaders() });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions(){
  return new Response(null, { headers: corsHeaders() });
}
