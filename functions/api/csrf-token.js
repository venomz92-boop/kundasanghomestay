// /api/csrf-token.js — Issues a fresh CSRF token for authenticated guests/owners
import {
  corsHeaders,
  enforceHttps,
  getGuestSession,
  getOwnerSession,
  generateCSRFToken,
  jsonResponse
} from './_utils.js';

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // Try guest session first
    const guest = await getGuestSession(request, env);
    if (guest && guest.userId) {
      const token = await generateCSRFToken(guest.userId, env);
      return jsonResponse({ success: true, token }, 200, request, { 'Cache-Control': 'no-store' });
    }

    // Then owner session
    const owner = await getOwnerSession(request, env);
    if (owner && owner.ownerId) {
      const token = await generateCSRFToken(owner.ownerId, env);
      return jsonResponse({ success: true, token }, 200, request, { 'Cache-Control': 'no-store' });
    }

    return jsonResponse({ error: 'Authentication required' }, 401, request);
  } catch (e) {
    console.error('csrf-token error:', e.message);
    return jsonResponse({ error: 'Failed to issue token' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
