// /api/owner-login.js - Owner Login (WhatsApp + Password) with homestay name in token

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
    "Access-Control-Allow-Headers": "Content-Type, Owner-Authorization"
  };
}

// Rate limiting (simple in-memory)
const loginAttempts = new Map();

export async function onRequestPost({ request, env }) {
  try {
    const { whatsapp, password } = await request.json();
    const cleanWhatsapp = whatsapp ? whatsapp.replace(/[^0-9]/g, '') : '';
    const cleanPassword = password ? password.trim() : '';

    if (!cleanWhatsapp || !cleanPassword) {
      return new Response(JSON.stringify({ error: "Missing credentials" }), { status: 400, headers: corsHeaders() });
    }

    // Rate limiting (5 attempts per 15 min)
    const key = cleanWhatsapp;
    const now = Date.now();
    const attempts = loginAttempts.get(key) || [];
    const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
    if (recent.length >= 5) {
      return new Response(JSON.stringify({ error: "Too many attempts" }), { status: 429, headers: corsHeaders() });
    }
    recent.push(now);
    loginAttempts.set(key, recent);

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server error" }), { status: 500, headers: corsHeaders() });
    }

    // Get approved homestays
    const r1 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    let homestays = [];
    if (r1 && r1.data) { try { homestays = JSON.parse(r1.data); } catch(e) {} }

    // Also check pending (just in case)
    const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
    if (r2 && r2.data) { try { homestays = [...homestays, ...JSON.parse(r2.data)]; } catch(e) {} }

    // Find owner by whatsapp
    const ownerHomestay = homestays.find(h => {
      const hWhatsapp = h.whatsapp ? h.whatsapp.replace(/[^0-9]/g, '') : '';
      return hWhatsapp === cleanWhatsapp && h.ownerPasswordHash && h.ownerSalt;
    });

    if (!ownerHomestay) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: corsHeaders() });
    }

    // Verify password
    const hashedInput = await sha256(cleanPassword + ownerHomestay.ownerSalt);
    if (hashedInput !== ownerHomestay.ownerPasswordHash) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: corsHeaders() });
    }

    // Login successful - clear attempts
    loginAttempts.delete(key);

    // ===== FIX: include homestay name in token =====
    const tokenData = {
      ownerId: ownerHomestay.id,
      ownerName: ownerHomestay.ownerName,
      homestayName: ownerHomestay.name,   // <-- ADDED
      whatsapp: cleanWhatsapp,
      ts: Date.now()
    };
    const ownerToken = btoa(JSON.stringify(tokenData));

    // Return safe data (exclude password hash and salt)
    const { ownerPasswordHash, ownerSalt, ...safeHomestay } = ownerHomestay;
    return new Response(JSON.stringify({
      success: true,
      token: ownerToken,
      homestay: {
        id: safeHomestay.id,
        name: safeHomestay.name,
        ownerName: safeHomestay.ownerName,
        whatsapp: safeHomestay.whatsapp
      },
      message: "Login successful"
    }), { status: 200, headers: corsHeaders() });

  } catch (e) {
    console.error("Owner login error:", e.message);
    return new Response(JSON.stringify({ error: "Login failed" }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}
