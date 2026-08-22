// /api/login.js - Guest login with PBKDF2 password verification (secure)
// SECURE: Rate limiting, input validation, proper error handling

// ========== UTILITY FUNCTIONS ==========

async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
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

// Rate limiting (in-memory, improve with D1/KV for production)
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

// ========== MAIN HANDLER ==========

export async function onRequestPost({ request, env }) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 400, headers: corsHeaders() });
    }
    if (!validateEmail(email)) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 400, headers: corsHeaders() });
    }

    const rateLimit = checkRateLimit(email);
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

    // --- Get guests ---
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r && r.data) { try { guests = JSON.parse(r.data); } catch(e) {} }

    // --- Check banned ---
    const bannedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
    let banned = [];
    if (bannedRes && bannedRes.data) { try { banned = JSON.parse(bannedRes.data); } catch(e) {} }
    const cleanEmail = email.toLowerCase().trim();
    if (banned.includes(cleanEmail)) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: corsHeaders() });
    }

    const user = guests.find(g => g.email && g.email.toLowerCase() === cleanEmail);
    if (!user) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: corsHeaders() });
    }

    // --- Verify password ---
    // Check if user has a salt (new secure accounts) or fallback for old SHA-256 accounts
    if (!user.salt) {
      // Legacy account without salt – instruct them to re-register (secure upgrade)
      console.warn(`Login attempt for legacy user without salt: ${cleanEmail}`);
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({
        error: "Your account needs to be upgraded for security. Please use 'Register' with the same email to create a new secure account.",
        needsUpgrade: true
      }), { status: 401, headers: corsHeaders() });
    }

    // Verify with PBKDF2
    const hashedInput = await hashPassword(password, user.salt);
    if (hashedInput !== user.password) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: corsHeaders() });
    }

    // --- Success ---
    loginAttempts.delete(cleanEmail);
    console.log(`✅ Login successful: ${cleanEmail}`);

    // Generate a simple session token (client-side only; no server-side state)
    const randomPart = Math.random().toString(36).substring(2, 10);
    const tokenData = { userId: user.id, email: user.email, ts: Date.now(), rand: randomPart };
    const sessionToken = btoa(JSON.stringify(tokenData));

    // Remove sensitive fields before returning
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
    console.error("❌ Login error:", e.message, e.stack);
    return new Response(JSON.stringify({ error: "Login failed. Please try again later." }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}
