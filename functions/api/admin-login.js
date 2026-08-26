// /api/admin-login.js
import { corsHeaders, getClientIP, enforceHttps, cookieHeader, jsonResponse, checkRateLimit, recordRateLimit, parseJSONSafely } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Database not configured' }, 500, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const rateOk = await checkRateLimit(db, clientIP, 'admin_login', 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }

    const { password } = await parseJSONSafely(request);

    if (!password || typeof password !== 'string') {
      await recordRateLimit(db, clientIP, 'admin_login');
      return jsonResponse({ error: "Invalid credentials" }, 400, request);
    }

    const adminPass = env.ADMIN_PASSWORD;
    if (!adminPass) {
      console.error("❌ ADMIN_PASSWORD environment variable is not set!");
      return jsonResponse({ error: "Server configuration error. Please contact support." }, 500, request);
    }

    if (password === adminPass) {
      // ✅ Return the static ADMIN_TOKEN from env
      const token = env.ADMIN_TOKEN;
      if (!token) {
        console.error("❌ ADMIN_TOKEN environment variable is not set!");
        return jsonResponse({ error: "Server configuration error. Please contact support." }, 500, request);
      }

      console.log(`✅ Admin login successful (IP: ${clientIP})`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        token: token,
        message: "Login successful"
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': cookieHeader('admin_token', token, 8 * 60 * 60),
          ...corsHeaders(request)
        }
      });
    } else {
      await recordRateLimit(db, clientIP, 'admin_login');
      return jsonResponse({ error: "Invalid credentials" }, 401, request);
    }
    
  } catch (e) {
    console.error("❌ Admin login error:", e.message);
    return jsonResponse({ error: "Login failed. Please try again later." }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
