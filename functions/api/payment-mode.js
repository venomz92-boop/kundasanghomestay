// /api/payment-mode.js - Uses TOYYIBPAY_PAYOUT_ENABLED from env

export async function onRequestGet({ env }) {
  // ============================================================
  // TOGGLE LIVE MODE WITH TOYYIBPAY_PAYOUT_ENABLED:
  //   "true"  = LIVE (ToyyibPay)
  //   "false" = SIMULATION (no real money)
  // ============================================================
  const isLive = (env.TOYYIBPAY_PAYOUT_ENABLED === "true");
  
  // Check if keys exist (for information only)
  const hasSecret = !!(env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_CATEGORY_CODE);
  
  // ===== FIX: enabled = isLive ONLY (don't require keys for the toggle) =====
  const enabled = isLive;
  
  return new Response(JSON.stringify({
    enabled: enabled,
    isLive: isLive,
    hasSecret: hasSecret,
    mode: isLive ? "live" : "simulation",
    message: enabled ? "LIVE - Payments go to ToyyibPay" : "SIMULATION - No real money",
    version: "2.0"
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
