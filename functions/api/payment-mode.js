// /api/payment-mode.js - AUTO-TOGGLE (env + fallback)

export async function onRequestGet({ env }) {
  // ============================================================
  // If the environment variable is NOT set or is undefined,
  // this default value will be used.
  // Set this to 'false' for simulation, 'true' for live.
  // Once the env var works, this fallback is ignored.
  // ============================================================
  const FALLBACK_MODE = 'false'; // <-- Change this to 'true' if you want live by default
  // ============================================================
  
  // Read the environment variable – if missing, use the fallback
  const rawValue = env.TOYYIBPAY_PAYOUT_ENABLED;
  const payoutEnabled = (rawValue !== undefined && rawValue !== null) ? rawValue : FALLBACK_MODE;
  const isLive = payoutEnabled.toLowerCase() === 'true';
  const hasSecret = !!env.TOYYIBPAY_SECRET_KEY;
  const enabled = isLive && hasSecret;
  
  return new Response(JSON.stringify({
    enabled: enabled,
    isLive: isLive,
    hasSecret: hasSecret,
    message: enabled ? "LIVE - Payments go to ToyyibPay" : "SIMULATION - No real money",
    // Include the raw value for debugging
    envValue: rawValue,
    usedFallback: rawValue === undefined || rawValue === null,
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
