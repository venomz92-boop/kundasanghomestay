// /api/owner-bookings.js - Fetch bookings for ALL homestays the owner manages
import { corsHeaders, getClientIP, logAction, enforceHttps } from './_utils.js';

function verifyOwner(request) {
  const auth = request.headers.get("Owner-Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const token = auth.replace("Bearer ", "");
    const data = JSON.parse(atob(token));
    if (data.ownerId && data.ts && (Date.now() - data.ts < 24 * 60 * 60 * 1000)) {
      return data;
    }
  } catch(e) { return null; }
  return null;
}

export async function onRequestGet({ request, env }) {
  const ownerData = verifyOwner(request);
  if (!ownerData) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
      status: 401, 
      headers: corsHeaders(request) 
    });
  }

  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "Server error" }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }

  try {
    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res && res.data) { try { bookings = JSON.parse(res.data); } catch(e) {} }

    const ownerHomestayIds = ownerData.homestayIds || [ownerData.ownerId];

    const myBookings = bookings.filter(b => {
      const bId = String(b.homestayId);
      return ownerHomestayIds.some(id => String(id) === bId);
    });

    return new Response(JSON.stringify(myBookings), { 
      status: 200, 
      headers: corsHeaders(request) 
    });
  } catch(e) {
    console.error("Owner bookings error:", e);
    return new Response(JSON.stringify({ error: "Failed to load bookings" }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
