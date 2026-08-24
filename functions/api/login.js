// /api/login.js - COMPLETE with security fixes
import { corsHeaders, getClientIP, sha256, generateSalt, enforceHttps } from './_utils.js';

const PEPPER = "kundasang-homestay-2026";

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// Rate limiting (in-memory)
const loginAttempts = new Map();
function checkRateLimit(email) {
  const key = email.toLowerCase();
  const now = Date.now();
  const attempts = loginAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  if (recent.length >= 5) return { blocked: true, remaining: 0 };
  return { blocked: false, remaining: 5 - recent.length };
}
function recordLoginAttempt(email) {
  const key = email.toLowerCase();
  const now = Date.now();
  const attempts = loginAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  recent.push(now);
  loginAttempts.set(key, recent);
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  try {
    const { email, password } = await request.json();

    const trimmedPassword = password ? password.trim() : '';
    const cleanEmail = email ? email.toLowerCase().trim() : '';

    if (!cleanEmail || !trimmedPassword) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }
    if (!validateEmail(cleanEmail)) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    const rateLimit = checkRateLimit(cleanEmail);
    if (rateLimit.blocked) {
      return new Response(JSON.stringify({ 
        error: "Too many login attempts. Please try again later.", 
        blocked: true 
      }), {
        status: 429,
        headers: corsHeaders(request)
      });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server configuration error" }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    // ✅ Ensure store table exists
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r && r.data) { try { guests = JSON.parse(r.data); } catch(e) {} }

    const bannedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
    let banned = [];
    if (bannedRes && bannedRes.data) { try { banned = JSON.parse(bannedRes.data); } catch(e) {} }
    if (banned.includes(cleanEmail)) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { 
        status: 401, 
        headers: corsHeaders(request) 
      });
    }

    const user = guests.find(g => g.email && g.email.toLowerCase() === cleanEmail);
    if (!user) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { 
        status: 401, 
        headers: corsHeaders(request) 
      });
    }

    // ✅ Use stored salt (not just global pepper)
    const hashedInput = await sha256(PEPPER + trimmedPassword + (user.salt || ''));

    if (hashedInput !== user.password) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { 
        status: 401, 
        headers: corsHeaders(request) 
      });
    }

    loginAttempts.delete(cleanEmail);

    const tokenData = { userId: user.id, email: user.email, ts: Date.now() };
    const sessionToken = btoa(JSON.stringify(tokenData));

    const { password: _, salt: __, ...safeUser } = user;
    
    // ✅ Set HttpOnly cookie
    return new Response(JSON.stringify({
      success: true,
      guest: safeUser,
      token: sessionToken,
      message: "Login successful"
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `guest_token=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Max-Age=86400; Path=/`,
        ...corsHeaders(request)
      }
    });

  } catch (e) {
    console.error("❌ Login error:", e.message);
    return new Response(JSON.stringify({ error: "Login failed. Please try again later." }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
