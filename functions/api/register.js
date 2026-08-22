// /api/register.js - Guest registration with password hashing

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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
    const { name, email, phone, password } = await request.json();

    if (!name || !email || !phone || !password) {
      return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: corsHeaders() });
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: corsHeaders() });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // Get existing guests
    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r && r.data) {
      try { guests = JSON.parse(r.data); } catch(e) {}
    }

    // Check if email already exists
    if (guests.some(g => g.email && g.email.toLowerCase() === email.toLowerCase())) {
      return new Response(JSON.stringify({ error: "Email already registered" }), { status: 400, headers: corsHeaders() });
    }

    // Hash password
    const hashedPassword = await sha256(password);

    const newGuest = {
      id: "G-" + Date.now(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      password: hashedPassword, // store hash only
      createdAt: new Date().toISOString(),
      bookingsCount: 0
    };

    guests.push(newGuest);
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_guests", JSON.stringify(guests)).run();

    // Return guest without password
    const { password: _, ...safeGuest } = newGuest;
    return new Response(JSON.stringify({ success: true, guest: safeGuest }), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (e) {
    console.error("Register error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}