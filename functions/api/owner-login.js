// /functions/api/owner-login.js - SECURE (No debug info)
import { corsHeaders, getClientIP, sha256, enforceHttps } from './_utils.js';

const PEPPER = "kundasang-homestay-2026";
const loginAttempts = new Map();

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  try {
    const { whatsapp, password } = await request.json();
    const cleanWhatsapp = whatsapp ? whatsapp.replace(/[^0-9]/g, '') : '';
    const cleanPassword = password ? password.trim() : '';

    if (!cleanWhatsapp || !cleanPassword) {
      return new Response(JSON.stringify({ error: "Missing credentials" }), {
        status: 400,
        headers: corsHeaders(request)
      });
    }

    // Rate limiting
    const clientIP = getClientIP(request);
    const key = clientIP + '_owner';
    const now = Date.now();
    const attempts = loginAttempts.get(key) || [];
    const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
    if (recent.length >= 5) {
      return new Response(JSON.stringify({ 
        error: "Too many login attempts. Please wait 15 minutes." 
      }), {
        status: 429,
        headers: corsHeaders(request)
      });
    }
    recent.push(now);
    loginAttempts.set(key, recent);

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server error - DB not found" }), {
        status: 500,
        headers: corsHeaders(request)
      });
    }

    // Ensure store table exists
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const r1 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    let homestays = [];
    if (r1 && r1.data) { try { homestays = JSON.parse(r1.data); } catch(e) {} }
    const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
    if (r2 && r2.data) { try { homestays = [...homestays, ...JSON.parse(r2.data)]; } catch(e) {} }

    // Find matches
    const ownerHomestays = homestays.filter(h => {
      const hWhatsapp = h.whatsapp ? h.whatsapp.replace(/[^0-9]/g, '') : '';
      return hWhatsapp === cleanWhatsapp && h.ownerPasswordHash && h.ownerSalt;
    });

    if (ownerHomestays.length === 0) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401,
        headers: corsHeaders(request)
      });
    }

    const firstMatch = ownerHomestays[0];
    const hashedInput = await sha256(PEPPER + cleanPassword + firstMatch.ownerSalt);
    
    if (hashedInput !== firstMatch.ownerPasswordHash) {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401,
        headers: corsHeaders(request)
      });
    }

    // Success
    loginAttempts.delete(key);

    const homestayList = ownerHomestays.map(h => ({
      id: h.id,
      name: h.name,
      location: h.location,
      ownerPrice: h.ownerPrice
    }));

    const homestayIds = ownerHomestays.map(h => h.id);
    const ownerName = ownerHomestays[0].ownerName;

    const tokenData = {
      ownerId: ownerHomestays[0].id,
      homestayIds: homestayIds,
      homestays: homestayList,
      ownerName: ownerName,
      whatsapp: cleanWhatsapp,
      ts: Date.now()
    };
    const ownerToken = btoa(JSON.stringify(tokenData));

    const safeHomestays = ownerHomestays.map(({ ownerPasswordHash, ownerSalt, ...rest }) => rest);

    return new Response(JSON.stringify({
      success: true,
      token: ownerToken,
      homestays: safeHomestays,
      message: "Login successful"
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(request)
      }
    });

  } catch (e) {
    console.error("Owner login error:", e.message);
    return new Response(JSON.stringify({ 
      error: "Server error. Please try again later." 
    }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
