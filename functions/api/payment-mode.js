// /api/payment-mode.js - WITH RAW DIAGNOSTIC

export async function onRequestGet({ env }) {
  // ============================================================
  // TOGGLE LIVE MODE WITH TOYYIBPAY_PAYOUT_ENABLED:
  //   "true"  = LIVE (ToyyibPay)
  //   "false" = SIMULATION (no real money)
  // ============================================================
  const rawPayoutEnabled = env.TOYYIBPAY_PAYOUT_ENABLED;
  const isLive = (rawPayoutEnabled === "false");
  
  // Check if keys exist (for information only)
  const hasSecret = !!(env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_CATEGORY_CODE);
  
  // ===== enabled = isLive ONLY =====
  const enabled = isLive;
  
  return new Response(JSON.stringify({
    enabled: enabled,
    isLive: isLive,
    hasSecret: hasSecret,
    mode: isLive ? "live" : "simulation",
    // ===== DIAGNOSTIC: show the raw value =====
    rawPayoutEnabled: rawPayoutEnabled,
    // ===== DEPLOYMENT STAMP =====
    version: "2.1",
    deployedAt: new Date().toISOString(),
    message: enabled ? "LIVE - Payments go to ToyyibPay" : "SIMULATION - No real money"
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
