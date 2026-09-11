// /api/logout.js — Clears guest cookie for THIS device only.
// Global logout is triggered by password reset (which bumps sessionVersion).
import {
  corsHeaders,
  clearCookieHeader,
  enforceHttps
} from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  return new Response(JSON.stringify({ success: true, message: 'Logged out' }), {
    status: 200,
    headers: {
      ...corsHeaders(request),
      'Set-Cookie': clearCookieHeader('guest_token')
    }
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
