// /functions/api/owner-login.js - Debug version with detailed error reporting
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

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server error - DB not found" }), {
        status: 500,
        headers: corsHeaders(request)
      });
    }

    // ✅ Ensure store table exists
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const r1 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    let homestays = [];
    if (r1 && r1.data) { try { homestays = JSON.parse(r1.data); } catch(e) {} }
    const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
    if (r2 && r2.data) { try { homestays = [...homestays, ...JSON.parse(r2.data)]; } catch(e) {} }

    // Debug: collect all homestays' info
    const allInfos = homestays.map(h => {
      const hWhatsapp = h.whatsapp ? h.whatsapp.replace(/[^0-9]/g, '') : '';
      return { 
        id: h.id, 
        name: h.name,
        storedWhatsapp: h.whatsapp,
        cleanedWhatsapp: hWhatsapp,
        hasHash: !!h.ownerPasswordHash,
        hasSalt: !!h.ownerSalt
      };
    });

    // Find matches
    const ownerHomestays = homestays.filter(h => {
      const hWhatsapp = h.whatsapp ? h.whatsapp.replace(/[^0-9]/g, '') : '';
      return hWhatsapp === cleanWhatsapp && h.ownerPasswordHash && h.ownerSalt;
    });

    if (ownerHomestays.length === 0) {
      // Return debug info
      return new Response(JSON.stringify({
        error: "Invalid credentials",
        debug: {
          inputWhatsapp: cleanWhatsapp,
          allHomestays: allInfos,
          matchingCandidates: homestays.filter(h => {
            const hW = h.whatsapp ? h.whatsapp.replace(/[^0-9]/g, '') : '';
            return hW === cleanWhatsapp;
          }).map(h => ({ id: h.id, name: h.name, hasHash: !!h.ownerPasswordHash, hasSalt: !!h.ownerSalt }))
        }
      }), {
        status: 401,
        headers: corsHeaders(request)
      });
    }

    const firstMatch = ownerHomestays[0];
    const hashedInput = await sha256(PEPPER + cleanPassword + firstMatch.ownerSalt);
    
    if (hashedInput !== firstMatch.ownerPasswordHash) {
      return new Response(JSON.stringify({
        error: "Invalid credentials",
        debug: {
          inputWhatsapp: cleanWhatsapp,
          matchedHomestay: {
            id: firstMatch.id,
            name: firstMatch.name,
            storedHash: firstMatch.ownerPasswordHash,
            computedHash: hashedInput,
            salt: firstMatch.ownerSalt
          }
        }
      }), {
        status: 401,
        headers: corsHeaders(request)
      });
    }

    // --- Success (no debug) ---
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
      error: "Server error: " + e.message 
    }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
