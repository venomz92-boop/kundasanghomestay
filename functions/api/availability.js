
export async function onRequestGet(context) {
  try {
    const kv = context.env.KD_DATA;
    const availability = await kv.get("kd_availability", { type: "json" }) || {};
    return new Response(JSON.stringify({ availability }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch(e){
    return new Response(JSON.stringify({ error: e.message, availability: {} }), { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}
export async function onRequestPost(context){
  try{
    const kv = context.env.KD_DATA;
    const body = await context.request.json();
    await kv.put("kd_availability", JSON.stringify(body.availability || body));
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}
export async function onRequestOptions(){
  return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}
