// /api/admin-logout.js
import { corsHeaders, clearCookieHeader } from './_utils.js';

export async function onRequestPost({ request }) {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearCookieHeader('admin_token'),
      ...corsHeaders(request)
    }
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
