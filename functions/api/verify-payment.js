// /api/verify-payment.js (MINIMAL TEST)
import { corsHeaders } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    console.log('✅ verify-payment minimal endpoint hit');
    const body = await request.text();
    console.log('📦 Raw body:', body);
    return new Response(JSON.stringify({ status: 'ok', body }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('💥 Minimal endpoint error:', e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}

// GET for quick check
export async function onRequestGet({ request }) {
  return new Response('verify-payment GET works', { headers: corsHeaders(request) });
}
