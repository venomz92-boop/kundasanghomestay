// /api/admin-login.js - SECURE: Login endpoint for admin
// Returns the ADMIN_TOKEN from env so it matches backend expectations

// ========== UTILITY FUNCTIONS ==========

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

// ========== SIMPLE RATE LIMITING (in-memory) ==========
// For production, use Cloudflare KV or D1 for persistence
const loginAttempts = new Map();

function checkRateLimit(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const attempts = loginAttempts.get(key) || [];
  
  // Clean old attempts (older than 15 minutes)
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  
  if (recent.length >= 5) {
    return { blocked: true, remaining: 0 };
  }
  
  return { blocked: false, remaining: 5 - recent.length };
}

function recordLoginAttempt(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const attempts = loginAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  recent.push(now);
  loginAttempts.set(key, recent);
}

// ========== MAIN HANDLER ==========

export async function onRequestPost({ request, env }) {
  try {
    // --- Get client IP for rate limiting ---
    const clientIP = request.headers.get('CF-Connecting-IP') || 
                     request.headers.get('X-Forwarded-For') || 
                     'unknown';
    
    // --- Rate limiting ---
    const rateLimit = checkRateLimit(clientIP);
    if (rateLimit.blocked) {
      console.log(`🚫 Admin login rate limit exceeded for IP: ${clientIP}`);
      return new Response(JSON.stringify({ 
        error: "Too many login attempts. Please wait 15 minutes." 
      }), {
        status: 429,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }

    // --- Parse request ---
    const { password } = await request.json();

    // --- Validate input ---
    if (!password || typeof password !== 'string') {
      recordLoginAttempt(clientIP);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }

    // --- Get password from environment ---
    const adminPass = env.ADMIN_PASSWORD;
    
    // --- Check if password is configured ---
    if (!adminPass) {
      console.error("❌ ADMIN_PASSWORD environment variable is not set!");
      return new Response(JSON.stringify({ 
        error: "Server configuration error. Please contact support." 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }

    // --- Verify password ---
    if (password === adminPass) {
      // --- Login successful - clear rate limit attempts ---
      loginAttempts.delete(clientIP);
      
      // --- Get token from environment (or use fallback) ---
      const token = env.ADMIN_TOKEN || "my-secure-admin-token";
      
      console.log(`✅ Admin login successful (IP: ${clientIP})`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        token: token,
        message: "Login successful"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    } else {
      // --- Failed attempt ---
      recordLoginAttempt(clientIP);
      console.log(`❌ Admin login failed (IP: ${clientIP})`);
      
      return new Response(JSON.stringify({ 
        error: "Invalid credentials"
      }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }
    
  } catch (e) {
    console.error("❌ Admin login error:", e.message, e.stack);
    return new Response(JSON.stringify({ 
      error: "Login failed. Please try again later." 
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors() }
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}
