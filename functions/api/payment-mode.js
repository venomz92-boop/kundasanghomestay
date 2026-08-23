// /api/payment-mode.js - HARDCODED TOGGLE (Guaranteed to work)

export async function onRequestGet({ env }) {
  // ============================================================
  // CHANGE THIS LINE to switch modes:
  //   true  = LIVE (redirect to ToyyibPay)
  //   false = SIMULATION (no real money)
  // ============================================================
  const IS_LIVE = false; // <-- Set to true for LIVE, false for SIMULATION
  // ============================================================
  
  // Check if secret key exists (for safety)
  const hasSecret = !!env.TOYYIBPAY_SECRET_KEY;
  const enabled = IS_LIVE && hasSecret;
  
  return new Response(JSON.stringify({
    enabled: enabled,
    isLive: IS_LIVE,
    hasSecret: hasSecret,
    message: enabled ? "LIVE - Payments go to ToyyibPay" : "SIMULATION - No real money",
    // Version stamp to verify deployment
    version: "2.0",
    mode: IS_LIVE ? "live" : "simulation"
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
