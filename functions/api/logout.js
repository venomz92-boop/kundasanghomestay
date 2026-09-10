// /api/logout.js – Clears guest cookie and invalidates session version
import {
  corsHeaders,
  clearCookieHeader,
  getGuestSession,
  incrementSessionVersion,
  jsonResponse,
  enforceHttps
} from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (session && session.userId && env.DB) {
      try {
        await incrementSessionVersion(env.DB, session.userId, 'guest');
      } catch (e) {
        // Best-effort – still clear the cookie
      }
    }
  } catch (e) {
    // Ignore – always attempt to clear the cookie
  }

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
