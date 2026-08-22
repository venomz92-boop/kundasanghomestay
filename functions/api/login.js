// /api/login.js - PHONE-FRIENDLY DEBUG (returns details in response)

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

// Rate limiting
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
      return new Response(JSON.stringify({ 
        error: "Invalid credentials",
        debug: "Email or password missing" 
      }), { status: 400, headers: corsHeaders() });
    }
    if (!validateEmail(cleanEmail)) {
      return new Response(JSON.stringify({ 
        error: "Invalid credentials",
        debug: "Invalid email format" 
      }), { status: 400, headers: corsHeaders() });
    }

    const rateLimit = checkRateLimit(cleanEmail);
    if (rateLimit.blocked) {
      return new Response(JSON.stringify({ 
        error: "Too many login attempts. Please try again later.",
        blocked: true 
      }), { status: 429, headers: corsHeaders() });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ 
        error: "Server configuration error",
        debug: "DB binding missing" 
      }), { status: 500, headers: corsHeaders() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r && r.data) { 
      try { guests = JSON.parse(r.data); } catch(e) { 
        return new Response(JSON.stringify({ 
          error: "Database error",
          debug: "Failed to parse guests: " + e.message 
        }), { status: 500, headers: corsHeaders() });
      }
    }

    // Check banned
    const bannedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
    let banned = [];
    if (bannedRes && bannedRes.data) { try { banned = JSON.parse(bannedRes.data); } catch(e) {} }
    if (banned.includes(cleanEmail)) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ 
        error: "Invalid credentials",
        debug: "Email is banned" 
      }), { status: 401, headers: corsHeaders() });
    }

    const user = guests.find(g => g.email && g.email.toLowerCase() === cleanEmail);
    if (!user) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ 
        error: "Invalid credentials",
        debug: `User not found: ${cleanEmail}` 
      }), { status: 401, headers: corsHeaders() });
    }

    // Legacy account without salt
    if (!user.salt) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({
        error: "Your account needs to be upgraded for security. Please use 'Register' with the same email to create a new secure account.",
        needsUpgrade: true,
        debug: "Legacy account - no salt"
      }), { status: 401, headers: corsHeaders() });
    }

    // Hash the password
    const hashedInput = await hashPassword(trimmedPassword, user.salt);

    // Return debug info if mismatch
    if (hashedInput !== user.password) {
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({
        error: "Invalid credentials",
        debug: {
          message: "Password hash mismatch",
          computedHashFirst10: hashedInput.substring(0, 10),
          storedHashFirst10: user.password.substring(0, 10),
          computedLength: hashedInput.length,
          storedLength: user.password.length,
          saltFirst10: user.salt.substring(0, 10),
          email: cleanEmail,
          userId: user.id
        }
      }), { status: 401, headers: corsHeaders() });
    }

    // --- Success ---
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
    console.error("❌ Login error:", e.message, e.stack);
    return new Response(JSON.stringify({ 
      error: "Login failed. Please try again later.",
      debug: e.message
    }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}
