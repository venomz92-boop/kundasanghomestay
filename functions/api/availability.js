export async function onRequestGet(context) {
  try {
    const DB = context.env.DB;
    const kv = context.env.KD_DATA || context.env.KD_AVAILABILITY;
    
    if (DB) {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT)`).run();
      await DB.prepare(`CREATE TABLE IF NOT EXISTS store2 (key TEXT PRIMARY KEY, data TEXT)`).run();
      // try both table formats (store.value and store.data)
      let row = null;
      try { row = await DB.prepare(`SELECT value FROM store WHERE key = ?`).bind('kd_availability').first(); } catch(e){}
      if (!row) {
        try { row = await DB.prepare(`SELECT data as value FROM store WHERE key = ?`).bind('kd_availability').first(); } catch(e){}
      }
      if (!row) {
        try { row = await DB.prepare(`SELECT value FROM store2 WHERE key = ?`).bind('kd_availability').first(); } catch(e){}
      }
      const availability = row && row.value ? JSON.parse(row.value) : {};
      return new Response(JSON.stringify({ availability }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    
    if (kv) {
      const availability = await kv.get("kd_availability", { type: "json" }) || {};
      return new Response(JSON.stringify({ availability }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(JSON.stringify({ availability: {} }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch(e){
    return new Response(JSON.stringify({ error: e.message, availability: {} }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
}

export async function onRequestPost(context){
  try{
    const DB = context.env.DB;
    const kv = context.env.KD_DATA || context.env.KD_AVAILABILITY;
    const body = await context.request.json();
    const availability = body.availability || body;

    if (DB) {
      await DB.prepare(`CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)`).run();
      await DB.prepare(`INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)`).bind('kd_availability', JSON.stringify(availability)).run();
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    if (kv) {
      await kv.put("kd_availability", JSON.stringify(availability));
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    return new Response(JSON.stringify({ error: "No DB or KV bound" }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
}

export async function onRequestOptions(){
  return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}
