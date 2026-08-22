// /api/login.js - Guest login with password hash verification

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
    const { email, password } = await request.json();

    if (!email || !password) {
      return new Response(JSON.stringify({ error: "Missing email or password" }), { status: 400, headers: corsHeaders() });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
    let guests = [];
    if (r && r.data) {
      try { guests = JSON.parse(r.data); } catch(e) {}
    }

    // Check banned
    const bannedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_banned_guests").first();
    let banned = [];
    if (bannedRes && bannedRes.data) {
      try { banned = JSON.parse(bannedRes.data); } catch(e) {}
    }
    if (banned.includes(email.toLowerCase())) {
      return new Response(JSON.stringify({ error: "This account is not exist" }), { status: 401, headers: corsHeaders() });
    }

    // Find user
    const user = guests.find(g => g.email && g.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      return new Response(JSON.stringify({ error: "This account is not exist" }), { status: 401, headers: corsHeaders() });
    }

    // Verify password
    const hashedInput = await sha256(password);
    if (hashedInput !== user.password) {
      return new Response(JSON.stringify({ error: "Invalid password" }), { status: 401, headers: corsHeaders() });
    }

    // Generate a simple session token (could be JWT, but we'll use a simple random string)
    const sessionToken = btoa(JSON.stringify({ userId: user.id, ts: Date.now() }));

    // Return safe user info (without password)
    const { password: _, ...safeUser } = user;
    return new Response(JSON.stringify({ success: true, guest: safeUser, token: sessionToken }), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (e) {
    console.error("Login error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}