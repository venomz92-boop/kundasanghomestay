// /api/admin-logout.js — Clears admin cookie
import { corsHeaders, clearCookieHeader, enforceHttps } from './_utils.js';

export async function onRequestPost({ request }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  return new Response(JSON.stringify({ success: true, message: 'Logged out' }), {
    status: 200,
    headers: {
      ...corsHeaders(request),
      'Set-Cookie': clearCookieHeader('admin_token')
    }
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
