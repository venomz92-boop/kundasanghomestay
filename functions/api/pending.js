// /api/pending - dedicated pending endpoint for multi-device sync
// SECURITY: GET requires admin auth to view full data; POST is public for submissions

function getDB(env){
  return env.DB || env.D1 || env.MY_DB || env.DATABASE || env.KUNDASANG_DB || env.STORE || null;
}

function corsHeaders(request){
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

// Admin verification
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
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders(request)
    });
  }
  return null;
}

// ========== GET - public returns count only, admin gets full data ==========
export async function onRequestGet(context){
  const { request, env } = context;
  const db = getDB(env);
  let pending = [];
  if(db){
    try{
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if(r) pending = JSON.parse(r.data);
    }catch(e){}
  }

  const authError = verifyAdmin(request, env);
  if (authError) {
    return new Response(JSON.stringify({ pending: [], count: pending.length, hasDB: !!db }), {
      status: 200,
      headers: corsHeaders(request)
    });
  }

  return new Response(JSON.stringify({ pending, count: pending.length, hasDB: !!db }), {
    status: 200,
    headers: corsHeaders(request)
  });
}

// ========== POST - PUBLIC (no auth needed) ==========
export async function onRequestPost(context){
  const { request, env } = context;

  const db = getDB(env);
  if(!db) {
    return new Response(JSON.stringify({ error: "DB not configured" }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
  
  try{
    const body = await request.json();
    // If body is an array directly, use it; if it's { pending: [...] } use that; otherwise empty array
    let pendingData = body;
    if (body.pending !== undefined) {
      pendingData = body.pending;
    }
    // Ensure it's an array
    let toSave = Array.isArray(pendingData) ? pendingData : [];
    
    // Validate each item (skip if empty)
    for (const item of toSave) {
      if (!item.id || !item.name) {
        return new Response(JSON.stringify({ error: "Missing required fields in pending item" }), {
          status: 400,
          headers: corsHeaders(request)
        });
      }
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_pending", JSON.stringify(toSave))
      .run();

    return new Response(JSON.stringify({ success: true, count: toSave.length }), {
      status: 200,
      headers: corsHeaders(request)
    });
  }catch(e){
    console.error("❌ Pending POST error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
}

// ========== DELETE - Admin only ==========
export async function onRequestDelete(context){
  const { request, env } = context;
  const authError = verifyAdmin(request, env);
  if (authError) return authError;

  const db = getDB(env);
  if(!db) {
    return new Response(JSON.stringify({ error: "DB not configured" }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
  try {
    // Clear pending entirely
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_pending", JSON.stringify([]))
      .run();
    return new Response(JSON.stringify({ success: true, message: "Pending cleared" }), {
      status: 200,
      headers: corsHeaders(request)
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
}

export async function onRequestOptions(){
  return new Response(null, { headers: corsHeaders(request) });
}
