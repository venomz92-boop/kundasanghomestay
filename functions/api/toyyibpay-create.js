// /api/toyyibpay-create.js - SECURE VERSION (Recalculates price server-side)

// ========== HELPER FUNCTIONS ==========
function calculateNights(checkin, checkout) {
  if (!checkin || !checkout) return 1;
  const d1 = new Date(checkin);
  const d2 = new Date(checkout);
  const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : 1;
}

function calculatePrice(ownerPrice, nights = 1) {
  const base = ownerPrice * nights;
  const fee = Math.round((base * 11) / 100); // 11% platform fee
  const gatewayFee = 1.00; // RM1 gateway fee
  const total = base + fee + gatewayFee;
  return { nights, base, fee, gatewayFee, total };
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { bookingId, homestayId, checkin, checkout, guestEmail, guestName, guestPhone } = body;

    // Validate required fields
    if (!bookingId || !homestayId || !checkin || !checkout) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }

    const secretKey = env.TOYYIBPAY_SECRET_KEY;
    const categoryCode = env.TOYYIBPAY_CATEGORY_CODE;
    const isLive = secretKey && categoryCode;
    const publicDomain = env.PUBLIC_DOMAIN || new URL(request.url).origin;

    // ========== SECURITY: FETCH HOMESTAY FROM DB TO RECALCULATE PRICE ==========
    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server configuration error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }

    // Get homestay from approved list
    const r1 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    let homestays = [];
    if (r1 && r1.data) { try { homestays = JSON.parse(r1.data); } catch(e) {} }

    // Also check pending (in case it's not approved yet)
    const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
    if (r2 && r2.data) { try { homestays = [...homestays, ...JSON.parse(r2.data)]; } catch(e) {} }

    // Find the homestay
    const homestay = homestays.find(h => String(h.id) === String(homestayId));
    if (!homestay) {
      return new Response(JSON.stringify({ error: "Homestay not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }

    // ========== SERVER-SIDE PRICE RECALCULATION ==========
    const nights = calculateNights(checkin, checkout);
    const price = calculatePrice(homestay.ownerPrice, nights);

    // IGNORE the frontend-sent total, base, fee. Use these server-calculated values.
    const total = price.total;
    const base = price.base;
    const fee = price.fee;

    console.log(`🔐 Server-recalculated price: Base RM${base} + Fee RM${fee} = Total RM${total} (${nights} nights)`);

    // ========== SIMULATION MODE (if keys missing) ==========
    if (!isLive) {
      return new Response(JSON.stringify({
        simulation: true,
        url: `https://toyyibpay.com/${bookingId}?amount=${total}`,
        id: bookingId,
        message: "Simulation mode - set TOYYIBPAY_SECRET_KEY and TOYYIBPAY_CATEGORY_CODE for live FPX"
      }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    // ========== CREATE TOYYIBPAY BILL ==========
    const formData = new FormData();
    formData.append("userSecretKey", secretKey);
    formData.append("categoryCode", categoryCode);
    formData.append("billName", `${homestay.name} - ${bookingId}`);
    formData.append("billDescription", `Kundasang Homestay ${bookingId} | ${checkin} -> ${checkout} | Base RM${base} + Fee RM${fee} | Total RM${total}`);
    formData.append("billPriceSetting", "1");
    formData.append("billPayorInfo", "1");
    formData.append("billAmount", Math.round(Number(total) * 100)); // SERVER-CALCULATED total
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
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }

    const billCode = data[0].BillCode;

    return new Response(JSON.stringify({
      success: true,
      url: `https://toyyibpay.com/${billCode}`,
      id: billCode,
      billCode,
      amount: total, // Server-calculated
      bookingId
    }), { headers: { "Content-Type": "application/json", ...cors() } });

  } catch (e) {
    console.error("❌ ToyyibPay error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors() }
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}
