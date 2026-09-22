// /api/owner-logout.js
import {
  corsHeaders,
  clearCookieHeader,
  enforceHttps,
  getOwnerSession,
  incrementOwnerSessionVersion
} from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  // Best-effort: bump session version so any outstanding token dies
  try {
    const owner = await getOwnerSession(request, env);
    if (owner && owner.ownerId && env.DB) {
      await incrementOwnerSessionVersion(env.DB, owner.ownerId);
    }
  } catch (e) { /* still clear cookie */ }

  return new Response(JSON.stringify({ success: true, message: 'Logged out' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearCookieHeader('owner_token'),
      ...corsHeaders(request, env)
    }
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}
