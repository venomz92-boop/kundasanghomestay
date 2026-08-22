// /api/register.js - Guest registration with password hashing

// ========== UTILITY FUNCTIONS ==========

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function validateEmail(email) {
  // Basic email validation
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validatePhone(phone) {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');
  // Must have at least 10 digits (Malaysian numbers are 10-11 digits)
  return digits.length >= 10 && digits.length <= 12;
}

function sanitizeString(str) {
  // Remove potentially dangerous characters
  if (!str) return '';
  return str.replace(/[<>]/g, '').trim();
}

// ========== CORS HEADERS ==========

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

// ========== MAIN HANDLER ==========

export async function onRequestPost({ request, env }) {
  try {
    // --- Parse request ---
    const body = await request.json();
    let { name, email, phone, password } = body;

    // --- Sanitize inputs ---
    name = sanitizeString(name);
    email = email ? email.toLowerCase().trim() : '';
    phone = phone ? phone.trim() : '';
    password = password ? password.trim() : '';

    // --- Validate required fields ---
    if (!name || !email || !phone || !password) {
      return new Response(JSON.stringify({ 
        error: "All fields are required" 
      }), { 
        status: 400, 
        headers: corsHeaders() 
      });
    }

    // --- Validate name ---
    if (name.length < 2 || name.length > 100) {
      return new Response(JSON.stringify({ 
        error: "Name must be between 2 and 100 characters" 
      }), { 
        status: 400, 
        headers: corsHeaders() 
      });
    }

    // --- Validate email ---
    if (!validateEmail(email)) {
      return new Response(JSON.stringify({ 
        error: "Please enter a valid email address" 
      }), { 
        status: 400, 
        headers: corsHeaders() 
      });
    }

    // --- Validate phone ---
    if (!validatePhone(phone)) {
      return new Response(JSON.stringify({ 
        error: "Please enter a valid phone number (at least 10 digits)" 
      }), { 
        status: 400, 
        headers: corsHeaders() 
      });
    }

    // --- Validate password ---
    if (password.length < 6) {
      return new Response(JSON.stringify({ 
        error: "Password must be at least 6 characters" 
      }), { 
        status: 400, 
        headers: corsHeaders() 
      });
    }

    if (password.length > 100) {
      return new Response(JSON.stringify({ 
        error: "Password is too long (max 100 characters)" 
      }), { 
        status: 400, 
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

    // --- Get existing guests ---
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r && r.data) {
      try { guests = JSON.parse(r.data); } catch(e) { 
        console.error("❌ Failed to parse guests:", e);
      }
    }

    // --- Check if email already exists ---
    if (guests.some(g => g.email && g.email.toLowerCase() === email)) {
      // Don't reveal if email exists (security: prevent email enumeration)
      return new Response(JSON.stringify({ 
        error: "Registration failed. Please try again." 
      }), { 
        status: 400, 
        headers: corsHeaders() 
      });
    }

    // --- Hash password ---
    const hashedPassword = await sha256(password);

    // --- Create guest object ---
    const newGuest = {
      id: "G-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6),
      name: name,
      email: email,
      phone: phone,
      password: hashedPassword, // store hash only
      createdAt: new Date().toISOString(),
      bookingsCount: 0,
      verified: false // for future email verification
    };

    // --- Save to database ---
    guests.push(newGuest);
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_guests", JSON.stringify(guests))
      .run();

    console.log(`✅ New guest registered: ${email}`);

    // --- Return guest without password ---
    const { password: _, ...safeGuest } = newGuest;
    
    return new Response(JSON.stringify({ 
      success: true, 
      guest: safeGuest,
      message: "Registration successful"
    }), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (e) {
    console.error("❌ Register error:", e.message, e.stack);
    return new Response(JSON.stringify({ 
      error: "Registration failed. Please try again later." 
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
