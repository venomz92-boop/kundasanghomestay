// /api/toyyibpay-create.js - SECURE: server-side price recalculation + auth
import { jwtVerify } from 'jose';

function getDatesInRange(checkin, checkout) {
  if (!checkin || !checkout) return [];
  const dates = [];
  const start = new Date(checkin + "T00:00:00");
  const end = new Date(checkout + "T00:00:00");
  if (isNaN(start) || isNaN(end) || start >= end) return [];
  const cur = new Date(start);
  while (cur < end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function calculateNights(checkin, checkout) {
  if (!checkin || !checkout) return 0;
  const d1 = new Date(checkin);
  const d2 = new Date(checkout);
  const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : 0;
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

async function verifyGuest(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.split(" ")[1];
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    return payload; // { userId, email, iat, exp }
  } catch {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  try {
    // --- 1. Authenticate guest ---
    const guest = await verifyGuest(request, env);
    if (!guest) {
      return new Response(JSON.stringify({ error: "Unauthorized - Please log in" }), {
        status: 401, headers: cors()
      });
    }

    const body = await request.json();
    const { bookingId, homestayId, checkin, checkout, guestName, guestEmail, guestPhone } = body;

    // --- 2. Validate required fields ---
    if (!bookingId || !homestayId || !checkin || !checkout) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400, headers: cors()
      });
    }

    const nights = calculateNights(checkin, checkout);
    if (nights <= 0) {
      return new Response(JSON.stringify({ error: "Invalid date range (checkout must be after checkin)" }), {
        status: 400, headers: cors()
      });
    }

    const db = env.DB;
    if (!db) {
      console.error("❌ DB not configured");
      return new Response(JSON.stringify({ error: "Server configuration error" }), {
        status: 500, headers: cors()
      });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // Fetch homestay price
    const hRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    let homestays = [];
    if (hRes?.data) {
      try { homestays = JSON.parse(hRes.data); } catch (e) {}
    }
    const demoRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_overrides").first();
    let demoOverrides = {};
    if (demoRes?.data) {
      try { demoOverrides = JSON.parse(demoRes.data); } catch (e) {}
    }

    let homestay = homestays.find(h => String(h.id) === String(homestayId));
    if (!homestay) {
      const demoEntry = demoOverrides[homestayId];
      if (demoEntry) homestay = demoEntry;
    }
    if (!homestay) {
      return new Response(JSON.stringify({ error: "Homestay not found" }), {
        status: 404, headers: cors()
      });
    }

    // Check availability
    const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
    let availabilityMap = {};
    if (availRes?.data) {
      try { availabilityMap = JSON.parse(availRes.data); } catch (e) {}
    }

    const blockedForHomestay = availabilityMap[String(homestayId)] || [];
    const requestedDates = getDatesInRange(checkin, checkout);
    const overlap = requestedDates.filter(d => blockedForHomestay.includes(d));
    if (overlap.length > 0) {
      return new Response(JSON.stringify({ error: "Selected dates are not available", blocked: overlap }), {
        status: 400, headers: cors()
      });
    }

    // Recalculate price
    const platformFeePercent = 11;
    const base = homestay.ownerPrice * nights;
    const fee = Math.round((base * platformFeePercent) / 100);
    const gatewayFee = 1;
    const total = base + fee + gatewayFee;

    const secretKey = env.TOYYIBPAY_SECRET_KEY;
    const categoryCode = env.TOYYIBPAY_CATEGORY_CODE;
    const isLive = secretKey && categoryCode;
    const publicDomain = env.PUBLIC_DOMAIN || new URL(request.url).origin;

    if (!isLive) {
      return new Response(JSON.stringify({
        simulation: true,
        url: `https://toyyibpay.com/${bookingId}?amount=${total}`,
        id: bookingId,
        message: "Simulation mode - set TOYYIBPAY_SECRET_KEY and TOYYIBPAY_CATEGORY_CODE for live FPX"
      }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    const formData = new FormData();
    formData.append("userSecretKey", secretKey);
    formData.append("categoryCode", categoryCode);
    formData.append("billName", `${homestay.name} - ${bookingId}`);
    formData.append("billDescription", `Kundasang Homestay ${bookingId} | ${checkin} -> ${checkout} | Base RM${base} + Fee RM${fee} | Total RM${total}`);
    formData.append("billPriceSetting", "1");
    formData.append("billPayorInfo", "1");
    formData.append("billAmount", Math.round(total * 100));
    formData.append("billReturnUrl", `${publicDomain}/?booking=${bookingId}&paid=1`);
    formData.append("billCallbackUrl", `${publicDomain}/api/toyyibpay-webhook`);
    formData.append("billExternalReferenceNo", bookingId);
    formData.append("billTo", guestName || "Guest");
    formData.append("billEmail", guestEmail || guest.email || "guest@kundasanghomestay.com");
    formData.append("billPhone", (guestPhone || "").replace(/[^0-9]/g, '').slice(-12) || "60123456789");
    formData.append("billSplitPayment", "0");
    formData.append("billPaymentChannel", "0");
    formData.append("billDisplayMerchant", "1");

    const res = await fetch("https://toyyibpay.com/index.php/api/createBill", {
      method: "POST",
      body: formData
    });

    const data = await res.json();

    if (!res.ok || !data || data[0]?.BillCode === undefined) {
      return new Response(JSON.stringify({ error: "ToyyibPay create failed", details: data }), {
        status: 400, headers: cors()
      });
    }

    const billCode = data[0].BillCode;

    return new Response(JSON.stringify({
      success: true,
      url: `https://toyyibpay.com/${billCode}`,
      id: billCode,
      billCode,
      amount: total,
      bookingId
    }), { headers: { "Content-Type": "application/json", ...cors() } });

  } catch (e) {
    console.error("❌ Payment creation error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: cors()
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}
