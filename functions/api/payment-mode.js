// /api/payment-mode.js - DIAGNOSTIC WITH ENV DUMP

export async function onRequestGet({ env, request }) {
  // Get the raw value
  const payoutEnabled = env.TOYYIBPAY_PAYOUT_ENABLED;
  const secretKey = env.TOYYIBPAY_SECRET_KEY ? 'present' : 'missing';
  
  // Create a response with diagnostic info
  const result = {
    // The actual value from env
    TOYYIBPAY_PAYOUT_ENABLED: payoutEnabled,
    
    // Interpreted values
    isTrue: payoutEnabled === 'true',
    isFalse: payoutEnabled === 'false',
    isUndefined: payoutEnabled === undefined || payoutEnabled === null,
    rawType: typeof payoutEnabled,
    rawLength: payoutEnabled ? payoutEnabled.length : 0,
    
    // Secret key status
    TOYYIBPAY_SECRET_KEY: secretKey,
    
    // Computed result
    enabled: payoutEnabled === 'true' && !!env.TOYYIBPAY_SECRET_KEY,
    
    // Debug: all env keys (without values for security)
    allKeys: Object.keys(env),
    
    // The actual message
    message: payoutEnabled === 'true' && !!env.TOYYIBPAY_SECRET_KEY 
      ? "LIVE - Payments go to ToyyibPay" 
      : "SIMULATION - No real money"
  };
  
  return new Response(JSON.stringify(result, null, 2), {
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
