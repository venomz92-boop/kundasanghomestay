// /api/owner-login.js - Owner Login (WhatsApp + Password) for MULTIPLE homestays

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

// Rate limiting
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

    // Get approved + pending homestays
    const r1 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    let homestays = [];
    if (r1 && r1.data) { try { homestays = JSON.parse(r1.data); } catch(e) {} }
    const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
    if (r2 && r2.data) { try { homestays = [...homestays, ...JSON.parse(r2.data)]; } catch(e) {} }

    // Find ALL homestays with matching WhatsApp
    const ownerHomestays = homestays.filter(h => {
      const hWhatsapp = h.whatsapp ? h.whatsapp.replace(/[^0-9]/g, '') : '';
      return hWhatsapp === cleanWhatsapp && h.ownerPasswordHash && h.ownerSalt;
    });

    if (ownerHomestays.length === 0) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: corsHeaders() });
    }

    // Verify password against the first match (assumes same password for all)
    const firstMatch = ownerHomestays[0];
    const hashedInput = await sha256(cleanPassword + firstMatch.ownerSalt);
    if (hashedInput !== firstMatch.ownerPasswordHash) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), { status: 401, headers: corsHeaders() });
    }

    // Login successful - clear attempts
    loginAttempts.delete(key);

    // Build homestay list for the token
    const homestayList = ownerHomestays.map(h => ({
      id: h.id,
      name: h.name,
      location: h.location,
      ownerPrice: h.ownerPrice
    }));

    const homestayIds = ownerHomestays.map(h => h.id);
    const ownerName = ownerHomestays[0].ownerName;

    const tokenData = {
      ownerId: ownerHomestays[0].id, // primary / fallback
      homestayIds: homestayIds,
      homestays: homestayList,
      ownerName: ownerName,
      whatsapp: cleanWhatsapp,
      ts: Date.now()
    };
    const ownerToken = btoa(JSON.stringify(tokenData));

    // Return safe data (exclude password hash and salt)
    const safeHomestays = ownerHomestays.map(({ ownerPasswordHash, ownerSalt, ...rest }) => rest);
    return new Response(JSON.stringify({
      success: true,
      token: ownerToken,
      homestays: safeHomestays,
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
