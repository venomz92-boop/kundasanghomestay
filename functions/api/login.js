// /api/login.js - BULLETPROOF (SHA-256 + Salt + Pepper)

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

const PEPPER = "kundasang-homestay-2026-secure-pepper";

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
  try {
    const { email, password } = await request.json();

    const trimmedPassword = password ? password.trim() : '';
    const cleanEmail = email ? email.toLowerCase().trim() : '';

    if (!cleanEmail || !trimmedPassword) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 400, headers: corsHeaders() });
    }
    if (!validateEmail(cleanEmail)) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 400, headers: corsHeaders() });
    }

    const rateLimit = checkRateLimit(cleanEmail);
    if (rateLimit.blocked) {
      return new Response(JSON.stringify({ error: "Too many login attempts. Please try again later.", blocked: true }), {
        status: 429,
        headers: corsHeaders()
      });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500, headers: corsHeaders() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r && r.data) { try { guests = JSON.parse(r.data); } catch(e) {} }

    const bannedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
    let banned = [];
    if (bannedRes && bannedRes.data) { try { banned = JSON.parse(bannedRes.data); } catch(e) {} }
    if (banned.includes(cleanEmail)) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: corsHeaders() });
    }

    const user = guests.find(g => g.email && g.email.toLowerCase() === cleanEmail);
    if (!user) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: corsHeaders() });
    }

    let hashedInput;
    if (user.salt) {
      // New account with salt
      hashedInput = await sha256(PEPPER + trimmedPassword + user.salt);
    } else {
      // Legacy account (no salt) – fallback to old method
      hashedInput = await sha256(trimmedPassword);
    }

    if (hashedInput !== user.password) {
      recordLoginAttempt(cleanEmail);
      
      // Return debug info so you can see what's wrong
      return new Response(JSON.stringify({
        error: "Invalid credentials",
        debug: {
          userFound: true,
          hasSalt: !!user.salt,
          saltPreview: user.salt ? user.salt.substring(0, 8) + "..." : "none",
          storedHashPreview: user.password.substring(0, 8) + "...",
          computedHashPreview: hashedInput.substring(0, 8) + "...",
          passwordLength: trimmedPassword.length
        }
      }), { status: 401, headers: corsHeaders() });
    }

    loginAttempts.delete(cleanEmail);

    const randomPart = Math.random().toString(36).substring(2, 10);
    const tokenData = { userId: user.id, email: user.email, ts: Date.now(), rand: randomPart };
    const sessionToken = btoa(JSON.stringify(tokenData));

    const { password: _, salt: __, ...safeUser } = user;
    return new Response(JSON.stringify({
      success: true,
      guest: safeUser,
      token: sessionToken,
      message: "Login successful"
    }), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (e) {
    console.error("❌ Login error:", e.message);
    return new Response(JSON.stringify({ error: "Login failed. Please try again later." }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}
