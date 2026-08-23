// /api/payment-mode.js - DIAGNOSTIC VERSION (shows everything)

export async function onRequestGet({ env, request }) {
  // Get the raw value
  const rawValue = env.TOYYIBPAY_PAYOUT_ENABLED;
  const secretKey = env.TOYYIBPAY_SECRET_KEY ? 'present' : 'missing';
  
  // Check if it's truly "true" or "false"
  const isTrue = rawValue === 'true';
  const isFalse = rawValue === 'false';
  const isUndefined = rawValue === undefined || rawValue === null;
  
  // Also check if there's any other variable that might override
  const allKeys = Object.keys(env);
  
  return new Response(JSON.stringify({
    // What you care about
    TOYYIBPAY_PAYOUT_ENABLED: rawValue,
    isTrue: isTrue,
    isFalse: isFalse,
    isUndefined: isUndefined,
    TOYYIBPAY_SECRET_KEY: secretKey,
    
    // Debug: all available env vars (filtered for security)
    allVariableNames: allKeys,
    totalVariables: allKeys.length,
    
    // Check if there's a "true" value anywhere
    truthyCheck: {
      rawValueType: typeof rawValue,
      rawValueLength: rawValue ? rawValue.length : 0,
    }
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
