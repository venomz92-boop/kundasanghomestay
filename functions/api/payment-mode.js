// /api/payment-mode.js - Returns ToyyibPay status from env vars

export async function onRequestGet({ env }) {
  const isLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
  
  return new Response(JSON.stringify({
    enabled: isLive,
    message: isLive ? "LIVE - Payments go to ToyyibPay" : "SIMULATION - No real money"
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
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