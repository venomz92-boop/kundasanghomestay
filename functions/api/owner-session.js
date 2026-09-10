// /api/owner-session.js — always 200, tells client if owner is logged in
import {
  corsHeaders,
  enforceHttps,
  getOwnerSession,
  jsonResponse
} from './_utils.js';

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const owner = await getOwnerSession(request, env);
    if (!owner || owner.type !== 'owner') {
      return jsonResponse({ authenticated: false }, 200, request, { 'Cache-Control': 'no-store' });
    }
    return jsonResponse({
      authenticated: true,
      ownerId: owner.ownerId,
      ownerName: owner.ownerName || null
    }, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return jsonResponse({ authenticated: false }, 200, request, { 'Cache-Control': 'no-store' });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
