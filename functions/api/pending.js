// /api/pending - dedicated pending endpoint for multi-device sync
// SECURITY: GET requires admin auth to view full data; POST is public for submissions

function getDB(env){
  return env.DB || env.D1 || env.MY_DB || env.DATABASE || env.KUNDASANG_DB || env.STORE || null;
}

function corsHeaders(){
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

// Admin verification (same as bookings.js)
function verifyAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expectedToken = env.ADMIN_TOKEN || "";
  if (!expectedToken) {
    // If ADMIN_TOKEN not set, reject all admin-protected requests
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: corsHeaders()
    });
  }
  const expected = "Bearer " + expectedToken;
  if (auth !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders()
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

  // Check if admin
  const authError = verifyAdmin(request, env);
  if (authError) {
    // Not admin – return only count
    return new Response(JSON.stringify({ pending: [], count: pending.length, hasDB: !!db }), {
      status: 200,
      headers: corsHeaders()
    });
  }

  // Admin – return full data
  return new Response(JSON.stringify({ pending, count: pending.length, hasDB: !!db }), {
    status: 200,
    headers: corsHeaders()
  });
}

// ========== POST - PUBLIC (no auth needed) ==========
export async function onRequestPost(context){
  const { request, env } = context;
  // No auth check – anyone can submit a pending homestay

  const db = getDB(env);
  if(!db) {
    return new Response(JSON.stringify({ error: "DB not configured" }), { 
      status: 500, 
      headers: corsHeaders() 
    });
  }
  
  try{
    const body = await request.json();
    const pending = body.pending || body || [];
    const toSave = Array.isArray(pending) ? pending : (body.pending || []);
    
    // Validate minimal structure
    if (!Array.isArray(toSave) || toSave.length === 0) {
      return new Response(JSON.stringify({ error: "Invalid pending data" }), {
        status: 400,
        headers: corsHeaders()
      });
    }

    // Basic validation: ensure each has at least id and name
    for (const item of toSave) {
      if (!item.id || !item.name) {
        return new Response(JSON.stringify({ error: "Missing required fields in pending item" }), {
          status: 400,
          headers: corsHeaders()
        });
      }
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_pending", JSON.stringify(toSave))
      .run();

    // If body.new is present, we add it (legacy support)
    if (body.new) {
      let existing = toSave;
      if (!Array.isArray(toSave) || toSave.length===0){
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
        if(r) existing = JSON.parse(r.data);
        existing.push(body.new);
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_pending", JSON.stringify(existing))
          .run();
      }
    }

    return new Response(JSON.stringify({ success: true, count: (toSave||[]).length }), {
      status: 200,
      headers: corsHeaders()
    });
  }catch(e){
    console.error("❌ Pending POST error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: corsHeaders()
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
      headers: corsHeaders()
    });
  }
  // DELETE logic (clear pending or remove specific item) – not used in frontend yet
  try {
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_pending", JSON.stringify([]))
      .run();
    return new Response(JSON.stringify({ success: true, message: "Pending cleared" }), {
      status: 200,
      headers: corsHeaders()
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: corsHeaders()
    });
  }
}

export async function onRequestOptions(){
  return new Response(null, { headers: corsHeaders() });
}