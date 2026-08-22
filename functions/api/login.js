// /api/login.js - Guest login with bcrypt and JWT
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';

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

// Simple in-memory rate limiter (per email) – for production, use Cloudflare KV
const loginAttempts = new Map();

function checkRateLimit(email) {
  const key = email.toLowerCase();
  const now = Date.now();
  const attempts = loginAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  if (recent.length >= 5) return { blocked: true };
  return { blocked: false };
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

    if (!email || !password) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 400, headers: corsHeaders()
      });
    }
    if (!validateEmail(email)) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 400, headers: corsHeaders()
      });
    }

    // Rate limiting
    const rate = checkRateLimit(email);
    if (rate.blocked) {
      return new Response(JSON.stringify({ error: "Too many login attempts. Please try again later." }), {
        status: 429, headers: corsHeaders()
      });
    }

    const db = env.DB;
    if (!db) {
      console.error("❌ DB not configured");
      return new Response(JSON.stringify({ error: "Server configuration error" }), {
        status: 500, headers: corsHeaders()
      });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // Fetch guests
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r?.data) {
      try { guests = JSON.parse(r.data); } catch(e) { console.error("Failed to parse guests:", e); }
    }

    // Check banned list
    const bannedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
    let banned = [];
    if (bannedRes?.data) {
      try { banned = JSON.parse(bannedRes.data); } catch(e) {}
    }
    const cleanEmail = email.toLowerCase().trim();
    if (banned.includes(cleanEmail)) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401, headers: corsHeaders()
      });
    }

    const user = guests.find(g => g.email?.toLowerCase() === cleanEmail);
    if (!user) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401, headers: corsHeaders()
      });
    }

    // --- Verify password with bcrypt ---
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401, headers: corsHeaders()
      });
    }

    // Clear rate limit on success
    loginAttempts.delete(cleanEmail);
    console.log(`✅ Login successful: ${cleanEmail}`);

    // --- Generate JWT ---
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    if (!env.JWT_SECRET) {
      console.error("❌ JWT_SECRET not set");
      return new Response(JSON.stringify({ error: "Server configuration error" }), {
        status: 500, headers: corsHeaders()
      });
    }
    const token = await new SignJWT({ userId: user.id, email: user.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret);

    const { password: _, ...safeUser } = user;
    return new Response(JSON.stringify({
      success: true,
      guest: safeUser,
      token: token,
      message: "Login successful"
    }), { status: 200, headers: corsHeaders() });

  } catch (e) {
    console.error("❌ Login error:", e.message);
    return new Response(JSON.stringify({ error: "Login failed. Please try again later." }), {
      status: 500, headers: corsHeaders()
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}
