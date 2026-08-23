// /api/payment-mode.js - PURE ENV (no fallback, auto-toggle)

export async function onRequestGet({ env }) {
  const isLive = env.TOYYIBPAY_PAYOUT_ENABLED === 'true' && !!env.TOYYIBPAY_SECRET_KEY;
  
  return new Response(JSON.stringify({
    enabled: isLive,
    isLive: isLive,
    hasSecret: !!env.TOYYIBPAY_SECRET_KEY,
    message: isLive ? "LIVE - Payments go to ToyyibPay" : "SIMULATION - No real money",
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
