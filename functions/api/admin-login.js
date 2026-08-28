import { corsHeaders, getClientIP, enforceHttps, cookieHeader, jsonResponse, checkRateLimit, recordRateLimit, parseJSONSafely } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Database not configured' }, 500, request);

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const rateOk = await checkRateLimit(db, clientIP, 'admin_login', 5, 900);
    if (!rateOk) return jsonResponse({ error: 'Too many attempts. Wait 15 mins.' }, 429, request);

    const { password } = await parseJSONSafely(request);
    const adminPass = env.ADMIN_PASSWORD;
    const adminToken = env.ADMIN_TOKEN;

    if (!adminPass || !adminToken) return jsonResponse({ error: "Server misconfigured" }, 500, request);

    if (password === adminPass) {
      return new Response(JSON.stringify({ success: true, token: adminToken, message: "Login successful" }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': cookieHeader('admin_token', adminToken, 28800),
          ...corsHeaders(request)
        }
      });
    } else {
      await recordRateLimit(db, clientIP, 'admin_login');
      return jsonResponse({ error: "Invalid credentials" }, 401, request);
    }
  } catch (e) {
    return jsonResponse({ error: "Login failed" }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
