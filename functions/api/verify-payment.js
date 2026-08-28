import { corsHeaders } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    return new Response(JSON.stringify({ status: 'ok', message: 'POST works' }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(e.message, { status: 500 });
  }
}

export async function onRequestGet({ request }) {
  return new Response('GET works', { headers: corsHeaders(request) });
}
