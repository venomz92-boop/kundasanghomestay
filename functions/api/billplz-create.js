export async function onRequestPost({ request, env }) {
  try {
    const { bookingId, total, homestayName, guestEmail, guestName } = await request.json();
    // total is in RM, convert to cents
    const amountCents = Math.round(Number(total) * 100);
    
    // Check if live keys exist in env
    const isLive = env.BILLPLZ_API_KEY && env.BILLPLZ_COLLECTION_ID;
    if (!isLive) {
      // Simulation mode - return fake URL
      return new Response(JSON.stringify({ 
        simulation: true,
        url: `https://www.billplz.com/bills/${bookingId}?amount=${total}`,
        id: bookingId,
        message: "Simulation mode - enable Billplz Secrets for live FPX"
      }), { headers: { "Content-Type": "application/json" } });
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
        callback_url: `https://kundasanghomestay.pages.dev/api/billplz-webhook`,
        redirect_url: `https://kundasanghomestay.pages.dev/?booking=${bookingId}&paid=1`,
        reference_1_label: "Booking ID",
        reference_1: bookingId,
        reference_2_label: "Platform Fee 11%",
        reference_2: "Service Fee"
      })
    });

    const bill = await billRes.json();
    if (!billRes.ok) {
      return new Response(JSON.stringify({ error: bill.error || "Billplz create failed", details: bill }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ 
      success: true,
      url: bill.url,
      id: bill.id,
      amount: bill.amount
    }), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
export async function onRequestOptions(){
  return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}
