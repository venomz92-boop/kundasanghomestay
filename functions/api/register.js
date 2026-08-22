// /api/register.js - Guest registration with PBKDF2 password hashing (secure)

// ========== UTILITY FUNCTIONS ==========

async function generateSalt() {
  const saltBuffer = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(saltBuffer).map(b => b.toString(16).padStart(2, '0')).join('');
}

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

function validatePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 12;
}

function sanitizeString(str) {
  if (!str) return '';
  return str.replace(/[<>]/g, '').trim();
}

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
    const body = await request.json();
    let { name, email, phone, password } = body;

    name = sanitizeString(name);
    email = email ? email.toLowerCase().trim() : '';
    phone = phone ? phone.trim() : '';
    password = password ? password.trim() : '';

    // --- Validations ---
    if (!name || !email || !phone || !password) {
      return new Response(JSON.stringify({ error: "All fields are required" }), { status: 400, headers: corsHeaders() });
    }
    if (name.length < 2 || name.length > 100) {
      return new Response(JSON.stringify({ error: "Name must be between 2 and 100 characters" }), { status: 400, headers: corsHeaders() });
    }
    if (!validateEmail(email)) {
      return new Response(JSON.stringify({ error: "Please enter a valid email address" }), { status: 400, headers: corsHeaders() });
    }
    if (!validatePhone(phone)) {
      return new Response(JSON.stringify({ error: "Please enter a valid phone number (at least 10 digits)" }), { status: 400, headers: corsHeaders() });
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: corsHeaders() });
    }
    if (password.length > 100) {
      return new Response(JSON.stringify({ error: "Password is too long (max 100 characters)" }), { status: 400, headers: corsHeaders() });
    }

    const db = env.DB;
    if (!db) {
      console.error("❌ Database not configured");
      return new Response(JSON.stringify({ error: "Server configuration error" }), { status: 500, headers: corsHeaders() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // --- Get existing guests ---
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r && r.data) {
      try { guests = JSON.parse(r.data); } catch(e) { console.error("Failed to parse guests:", e); }
    }

    // --- Check if email already exists ---
    if (guests.some(g => g.email && g.email.toLowerCase() === email)) {
      // Do not reveal existence
      return new Response(JSON.stringify({ error: "Registration failed. Please try again." }), { status: 400, headers: corsHeaders() });
    }

    // --- Generate salt and hash ---
    const salt = await generateSalt();
    const hashedPassword = await hashPassword(password, salt);

    // --- Create guest object ---
    const newGuest = {
      id: "G-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6),
      name: name,
      email: email,
      phone: phone,
      password: hashedPassword,
      salt: salt,          // store salt alongside
      createdAt: new Date().toISOString(),
      bookingsCount: 0,
      verified: false
    };

    guests.push(newGuest);
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_guests", JSON.stringify(guests))
      .run();

    console.log(`✅ New guest registered: ${email}`);

    const { password: _, salt: __, ...safeGuest } = newGuest; // remove password and salt
    return new Response(JSON.stringify({ success: true, guest: safeGuest, message: "Registration successful" }), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (e) {
    console.error("❌ Register error:", e.message, e.stack);
    return new Response(JSON.stringify({ error: "Registration failed. Please try again later." }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}
