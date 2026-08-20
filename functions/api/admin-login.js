// /api/admin-login - Secure server-side password check
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { password } = body;
    if (!password) return new Response(JSON.stringify({ error: "Missing password" }), { status: 400, headers: corsJson() });
    const expectedHash = context.env.ADMIN_PASSWORD_HASH || "b9276e0bc88047b500d985a7bf9f7bf543cd428b9ca1906128cdf9797bb83d33";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
    const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (hash === expectedHash) {
      return new Response(JSON.stringify({ success: true }), { headers: corsJson() });
    } else {
      return new Response(JSON.stringify({ error: "Wrong password" }), { status: 401, headers: corsJson() });
    }
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsJson() });
  }
}
function corsJson(){ return { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }); }
