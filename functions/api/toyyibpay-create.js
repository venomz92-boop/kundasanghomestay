// /api/toyyibpay-create.js - COMPLETE with security fixes
import { corsHeaders, getClientIP, logAction, enforceHttps } from './_utils.js';

function calculateNights(checkin, checkout) {
  if (!checkin || !checkout) return 1;
  const d1 = new Date(checkin);
  const d2 = new Date(checkout);
  const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : 1;
}

function calculatePrice(ownerPrice, nights = 1) {
  const base = ownerPrice * nights;
  const fee = Math.round((base * 11) / 100);
  const gatewayFee = 1.00;
  const total = base + fee + gatewayFee;
  return { nights, base, fee, gatewayFee, total };
}

const DEMO_HOMESTAYS = [
  {
    id: 1,
    name: "A-Frame Cabin with Kinabalu View",
    location: "Bundu Tuhan",
    ownerPrice: 300,
    rating: 4.9,
    reviews: 127,
    guests: 4,
    bedrooms: 2,
    image: "https://images.unsplash.com/photo-1449158743715-0a90ebb6d2d8?w=800",
    approved: true,
    verified: true,
    ownerName: "Ali",
    ownerBank: "CIMB",
    ownerBankAccount: "8600-123456",
    bankCode: "CIMBMYKL",
    whatsapp: "60123456789",
    description: "View Gunung Kinabalu terus dari bilik."
  },
  {
    id: 2,
    name: "Desa Cattle Farm View Homestay",
    location: "Desa",
    ownerPrice: 250,
    rating: 4.8,
    reviews: 89,
    guests: 6,
    bedrooms: 3,
    image: "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800",
    approved: true,
    verified: true,
    ownerName: "Maria",
    ownerBank: "Maybank",
    ownerBankAccount: "1140-987654",
    bankCode: "MBBEMYKL",
    whatsapp: "60123456789",
    description: "5 min to Desa Cattle Farm, ada dapur."
  }
];

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  try {
    const body = await request.json();
    const { bookingId, homestayId, checkin, checkout, guestEmail, guestName, guestPhone } = body;

    if (!bookingId || !homestayId || !checkin || !checkout) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: corsHeaders(request)
      });
    }

    // ✅ CORRECT: Check for "true" (not "false")
    const isLive = (env.TOYYIBPAY_PAYOUT_ENABLED === "true");
    const secretKey = env.TOYYIBPAY_SECRET_KEY;
    const categoryCode = env.TOYYIBPAY_CATEGORY_CODE;
    const hasKeys = !!(secretKey && categoryCode);
    const useLive = isLive && hasKeys;

    const publicDomain = env.PUBLIC_DOMAIN || new URL(request.url).origin;

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server configuration error" }), {
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

    let homestay = homestays.find(h => String(h.id) === String(homestayId));

    if (!homestay) {
      homestay = DEMO_HOMESTAYS.find(h => String(h.id) === String(homestayId));
    }

    if (!homestay) {
      return new Response(JSON.stringify({ error: "Homestay not found" }), {
        status: 404,
        headers: corsHeaders(request)
      });
    }

    const nights = calculateNights(checkin, checkout);
    const price = calculatePrice(homestay.ownerPrice, nights);
    const total = price.total;
    const base = price.base;
    const fee = price.fee;

    if (!useLive) {
      return new Response(JSON.stringify({
        simulation: true,
        url: `https://toyyibpay.com/${bookingId}?amount=${total}`,
        id: bookingId,
        message: "SIMULATION MODE – Set TOYYIBPAY_PAYOUT_ENABLED=true for live payments"
      }), { headers: corsHeaders(request) });
    }

    const formData = new FormData();
    formData.append("userSecretKey", secretKey);
    formData.append("categoryCode", categoryCode);
    formData.append("billName", `${homestay.name} - ${bookingId}`);
    formData.append("billDescription", `Kundasang Homestay ${bookingId} | ${checkin} -> ${checkout} | Base RM${base} + Fee RM${fee} | Total RM${total}`);
    formData.append("billPriceSetting", "1");
    formData.append("billPayorInfo", "1");
    formData.append("billAmount", Math.round(Number(total) * 100));
    formData.append("billReturnUrl", `${publicDomain}/?booking=${bookingId}&paid=1`);
    formData.append("billCallbackUrl", `${publicDomain}/api/toyyibpay-webhook`);
    formData.append("billExternalReferenceNo", bookingId);
    formData.append("billTo", guestName || "Guest");
    formData.append("billEmail", guestEmail || "guest@kundasanghomestay.com");
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
        status: 400,
        headers: corsHeaders(request)
      });
    }

    const billCode = data[0].BillCode;

    await logAction({
      db,
      action: 'toyyibpay_bill_created',
      admin: 'guest',
      details: `Bill ${billCode} created for booking ${bookingId}, total RM${total}`,
      ip: getClientIP(request),
      userId: guestEmail,
      homestayId: homestayId
    });

    return new Response(JSON.stringify({
      success: true,
      url: `https://toyyibpay.com/${billCode}`,
      id: billCode,
      billCode,
      amount: total,
      bookingId
    }), { headers: corsHeaders(request) });

  } catch (e) {
    console.error("❌ ToyyibPay error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
