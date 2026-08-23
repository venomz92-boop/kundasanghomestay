// /api/payment-mode.js - Returns ToyyibPay status from env vars

export async function onRequestGet({ env }) {
  // Read the environment variable, case-insensitive
  const payoutEnabled = env.TOYYIBPAY_PAYOUT_ENABLED || 'false';
  const isLive = payoutEnabled.toLowerCase() === 'true';
  
  // Also check if secret key exists (optional extra check)
  const hasSecret = !!env.TOYYIBPAY_SECRET_KEY;
  
  const enabled = isLive && hasSecret;
  
  return new Response(JSON.stringify({
    enabled: enabled,
    isLive: isLive,
    hasSecret: hasSecret,
    message: enabled ? "LIVE - Payments go to ToyyibPay" : "SIMULATION - No real money",
    // Debug info (remove later if you want)
    rawPayoutEnv: payoutEnabled,
    payoutEnabled: env.TOYYIBPAY_PAYOUT_ENABLED
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
