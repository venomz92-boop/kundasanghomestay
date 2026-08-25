// /api/login.js - COMPLETE with security fixes + CSRF
import { corsHeaders, getClientIP, sha256, generateSalt, enforceHttps, generateCSRFToken } from './_utils.js';

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
      return new Response(JSON.stringify({ error: "Email and password are required" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }
    if (!validateEmail(cleanEmail)) {
      return new Response(JSON.stringify({ error: "Invalid email format" }), { 
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
      console.error("❌ No database configured");
      return new Response(JSON.stringify({ error: "Server configuration error" }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    // Ensure store table exists
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    } catch (e) {
      console.error("❌ Failed to create store table:", e);
      return new Response(JSON.stringify({ error: "Database error" }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    // Get guests
    let guests = [];
    try {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
      if (r && r.data) { 
        try { guests = JSON.parse(r.data); } catch(e) { console.error("Failed to parse guests:", e); }
      }
    } catch (e) {
      console.error("❌ Failed to fetch guests:", e);
      return new Response(JSON.stringify({ error: "Database error" }), { 
        status: 500, 
        headers: corsHeaders(request) 
      });
    }

    // Get banned guests
    let banned = [];
    try {
      const bannedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
      if (bannedRes && bannedRes.data) { 
        try { banned = JSON.parse(bannedRes.data); } catch(e) {}
      }
    } catch (e) {
      console.error("❌ Failed to fetch banned guests:", e);
    }

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

    // Use stored salt
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

    // ✅ Generate CSRF token for this user
    const csrfToken = generateCSRFToken(user.id);
    
    return new Response(JSON.stringify({
      success: true,
      guest: safeUser,
      token: sessionToken,
      csrfToken: csrfToken,
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
    console.error("Stack:", e.stack);
    return new Response(JSON.stringify({ 
      error: "Login failed: " + e.message 
    }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
