// /api/verify-payment.js (MINIMAL TEST)
import { corsHeaders } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    return new Response(JSON.stringify({ message: 'OK' }), {
      status: 200,
      headers: { ...corsHeaders(request) }
    });
  } catch (e) {
    return new Response(e.message, { status: 500, headers: corsHeaders(request) });
  }
}
