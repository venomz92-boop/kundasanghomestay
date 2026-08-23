// /api/payment-mode.js - DIAGNOSTIC (shows raw env)

export async function onRequestGet({ env }) {
  // Get the raw value from the environment
  const rawValue = env.TOYYIBPAY_PAYOUT_ENABLED;
  const secretKey = env.TOYYIBPAY_SECRET_KEY ? 'present' : 'missing';
  
  // Determine if it's true/false/undefined
  const isTrue = rawValue === 'true';
  const isFalse = rawValue === 'false';
  const isUndefined = rawValue === undefined || rawValue === null;
  
  // Compute live status (only if both are true)
  const isLive = isTrue && !!env.TOYYIBPAY_SECRET_KEY;
  
  return new Response(JSON.stringify({
    // Raw value from Cloudflare
    rawValue: rawValue,
    isTrue,
    isFalse,
    isUndefined,
    secretKey,
    isLive,
    // This is what the frontend will use
    enabled: isLive,
    message: isLive ? "LIVE - Payments go to ToyyibPay" : "SIMULATION - No real money",
    // Extra debug
    allKeys: Object.keys(env),
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
