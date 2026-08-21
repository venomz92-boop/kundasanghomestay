export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { bookingId, total, homestayName, guestEmail, guestName } = body;
    const amountCents = Math.round(Number(total) * 100);
    
    // BUG FIX: use dynamic domain from request or env, not hardcoded
    const origin = new URL(request.url).origin;
    // Allow env override for production domain
    const publicDomain = env.PUBLIC_DOMAIN || "https://kundasanghomestay.pages.dev";
    
    const isLive = env.BILLPLZ_API_KEY && env.BILLPLZ_COLLECTION_ID;
    if (!isLive) {
      return new Response(JSON.stringify({ 
        simulation: true,
        url: `https://www.billplz.com/bills/${bookingId}?amount=${total}`,
        id: bookingId,
        message: "Simulation mode - enable Billplz Secrets for live FPX"
      }), { headers: { "Content-Type": "application/json", ...cors() } });
    }

    const auth = btoa(env.BILLPLZ_API_KEY + ":");
    const billRes = await fetch("https://www.billplz.com/api/v3/bills", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + auth,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        collection_id: env.BILLPLZ_COLLECTION_ID,
        email: guestEmail || "guest@kundasanghomestay.com",
        name: guestName || "Guest",
        amount: amountCents,
        description: `${homestayName} Booking ${bookingId} - Kundasang Homestay`,
        callback_url: `${publicDomain}/api/billplz-webhook`,
        redirect_url: `${publicDomain}/?booking=${bookingId}&paid=1`,
        reference_1_label: "Booking ID",
        reference_1: bookingId,
        reference_2_label: "Platform Fee 11%",
        reference_2: "Service Fee"
      })
    });

    const bill = await billRes.json();
    if (!billRes.ok) {
      return new Response(JSON.stringify({ error: bill.error || "Billplz create failed", details: bill }), { status: 400, headers: { "Content-Type": "application/json", ...cors() } });
    }

    return new Response(JSON.stringify({ 
      success: true,
      url: bill.url,
      id: bill.id,
      amount: bill.amount
    }), { headers: { "Content-Type": "application/json", ...cors() } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json", ...cors() } });
  }
}

function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }

export async function onRequestOptions(){
  return new Response(null, { headers: cors() });
}
