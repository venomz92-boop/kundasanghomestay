// /api/toyyibpay-create.js - Fastest for Sabah PBT license
// Replaces billplz-create.js

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { bookingId, total, homestayName, guestEmail, guestName, guestPhone, base, fee, checkin, checkout, homestayId } = body;
    
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

    // ToyyibPay API - create bill
    const formData = new FormData();
    formData.append("userSecretKey", secretKey);
    formData.append("categoryCode", categoryCode);
    formData.append("billName", `${homestayName} - ${bookingId}`);
    formData.append("billDescription", `Kundasang Homestay ${bookingId} | ${checkin} -> ${checkout} | Base RM${base} + Fee RM${fee} | Total RM${total}`);
    formData.append("billPriceSetting", "1"); // fixed price
    formData.append("billPayorInfo", "1"); // require payor info
    formData.append("billAmount", Math.round(Number(total) * 100)); // in cents
    formData.append("billReturnUrl", `${publicDomain}/?booking=${bookingId}&paid=1`);
    formData.append("billCallbackUrl", `${publicDomain}/api/toyyibpay-webhook`);
    formData.append("billExternalReferenceNo", bookingId);
    formData.append("billTo", guestName || "Guest");
    formData.append("billEmail", guestEmail || "guest@kundasanghomestay.com");
    formData.append("billPhone", (guestPhone||"").replace(/[^0-9]/g,'').slice(-12) || "60123456789");
    formData.append("billSplitPayment", "0"); // we handle split on check-in, not at payment time
    formData.append("billPaymentChannel", "0"); // FPX
    formData.append("billDisplayMerchant", "1");

    const res = await fetch("https://toyyibpay.com/index.php/api/createBill", {
      method: "POST",
      body: formData
    });

    const data = await res.json();

    if (!res.ok || !data || data[0]?.BillCode === undefined) {
      return new Response(JSON.stringify({ error: "ToyyibPay create failed", details: data }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
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
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
  }
}

function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: cors() }); }
