// /api/login.js - Guest login with password hash verification
// SECURE: Rate limiting, input validation, and proper error handling

// ========== UTILITY FUNCTIONS ==========

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

// ========== SIMPLE RATE LIMITING (in-memory) ==========
// Note: For production, use Cloudflare KV or D1 for persistence
const loginAttempts = new Map();

function checkRateLimit(email) {
  const key = email.toLowerCase();
  const now = Date.now();
  const attempts = loginAttempts.get(key) || [];
  
  // Clean old attempts (older than 15 minutes)
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  
  if (recent.length >= 5) {
    return { blocked: true, remaining: 0 };
  }
  
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
    // --- Parse request ---
    const { email, password } = await request.json();

    // --- Validate required fields ---
    if (!email || !password) {
      console.log("❌ Login failed: Missing email or password");
      return new Response(JSON.stringify({ 
        error: "Invalid credentials"  // Generic message for security
      }), { 
        status: 400, 
        headers: corsHeaders() 
      });
    }

    // --- Validate email format ---
    if (!validateEmail(email)) {
      console.log(`❌ Login failed: Invalid email format - ${email}`);
      return new Response(JSON.stringify({ 
        error: "Invalid credentials"
      }), { 
        status: 400, 
        headers: corsHeaders() 
      });
    }

    // --- Rate limiting ---
    const rateLimit = checkRateLimit(email);
    if (rateLimit.blocked) {
      console.log(`🚫 Login rate limit exceeded for: ${email}`);
      return new Response(JSON.stringify({ 
        error: "Too many login attempts. Please try again later.",
        blocked: true
      }), { 
        status: 429, 
        headers: corsHeaders() 
      });
    }

    // --- Database connection ---
    const db = env.DB;
    if (!db) {
      console.error("❌ Database not configured");
      return new Response(JSON.stringify({ 
        error: "Server configuration error" 
      }), { 
        status: 500, 
        headers: corsHeaders() 
      });
    }

    // --- Initialize table ---
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // --- Get guests from database ---
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r && r.data) {
      try { guests = JSON.parse(r.data); } catch(e) {
        console.error("❌ Failed to parse guests:", e);
      }
    }

    // --- Check banned list ---
    const bannedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
    let banned = [];
    if (bannedRes && bannedRes.data) {
      try { banned = JSON.parse(bannedRes.data); } catch(e) {}
    }
    
    const cleanEmail = email.toLowerCase().trim();
    if (banned.includes(cleanEmail)) {
      console.log(`🚫 Blocked login attempt for banned user: ${cleanEmail}`);
      // Record attempt but don't reveal ban status
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ 
        error: "Invalid credentials"
      }), { 
        status: 401, 
        headers: corsHeaders() 
      });
    }

    // --- Find user by email ---
    const user = guests.find(g => g.email && g.email.toLowerCase() === cleanEmail);
    if (!user) {
      console.log(`❌ Login failed: User not found - ${cleanEmail}`);
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ 
        error: "Invalid credentials"
      }), { 
        status: 401, 
        headers: corsHeaders() 
      });
    }

    // --- Verify password ---
    const hashedInput = await sha256(password);
    if (hashedInput !== user.password) {
      console.log(`❌ Login failed: Wrong password for ${cleanEmail}`);
      recordLoginAttempt(cleanEmail);
      return new Response(JSON.stringify({ 
        error: "Invalid credentials"
      }), { 
        status: 401, 
        headers: corsHeaders() 
      });
    }

    // --- Login successful - clear rate limit attempts ---
    loginAttempts.delete(cleanEmail);
    console.log(`✅ Login successful: ${cleanEmail}`);

    // --- Generate session token ---
    // Using a more secure token with random component
    const randomPart = Math.random().toString(36).substring(2, 10);
    const tokenData = { 
      userId: user.id, 
      email: user.email,
      ts: Date.now(),
      rand: randomPart
    };
    const sessionToken = btoa(JSON.stringify(tokenData));

    // --- Return safe user info (without password) ---
    const { password: _, ...safeUser } = user;
    
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
      error: "Login failed. Please try again later." 
    }), { 
      status: 500, 
      headers: corsHeaders() 
    });
  }
}

// ========== OPTIONS HANDLER ==========

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}
