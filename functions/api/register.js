// /api/register.js - Guest registration with bcrypt hashing

import bcrypt from 'bcryptjs';

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

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    let { name, email, phone, password } = body;

    name = sanitizeString(name);
    email = email ? email.toLowerCase().trim() : '';
    phone = phone ? phone.trim() : '';
    password = password ? password.trim() : '';

    // --- Validation ---
    if (!name || !email || !phone || !password) {
      return new Response(JSON.stringify({ error: "All fields are required" }), {
        status: 400, headers: corsHeaders()
      });
    }
    if (name.length < 2 || name.length > 100) {
      return new Response(JSON.stringify({ error: "Name must be between 2 and 100 characters" }), {
        status: 400, headers: corsHeaders()
      });
    }
    if (!validateEmail(email)) {
      return new Response(JSON.stringify({ error: "Please enter a valid email address" }), {
        status: 400, headers: corsHeaders()
      });
    }
    if (!validatePhone(phone)) {
      return new Response(JSON.stringify({ error: "Please enter a valid phone number (at least 10 digits)" }), {
        status: 400, headers: corsHeaders()
      });
    }
    if (password.length < 6 || password.length > 100) {
      return new Response(JSON.stringify({ error: "Password must be between 6 and 100 characters" }), {
        status: 400, headers: corsHeaders()
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

    // Fetch existing guests
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r?.data) {
      try { guests = JSON.parse(r.data); } catch(e) { console.error("Failed to parse guests:", e); }
    }

    // Check email existence (generic error)
    if (guests.some(g => g.email?.toLowerCase() === email)) {
      return new Response(JSON.stringify({ error: "Registration failed. Please try again." }), {
        status: 400, headers: corsHeaders()
      });
    }

    // --- Secure password hashing with bcrypt ---
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newGuest = {
      id: "G-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6),
      name,
      email,
      phone,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
      bookingsCount: 0,
      verified: false
    };

    guests.push(newGuest);
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_guests", JSON.stringify(guests))
      .run();

    console.log(`✅ New guest registered: ${email}`);

    // Remove password before sending
    const { password: _, ...safeGuest } = newGuest;
    return new Response(JSON.stringify({ success: true, guest: safeGuest, message: "Registration successful" }), {
      status: 200, headers: corsHeaders()
    });

  } catch (e) {
    console.error("❌ Register error:", e.message);
    return new Response(JSON.stringify({ error: "Registration failed. Please try again later." }), {
      status: 500, headers: corsHeaders()
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}
