// /api/csrf-token.js — Issues a fresh CSRF token for the account type
// the caller asks for.
//
// [REVISION — 22 Sept 2026 — Phase 3]
// The token is now bound to the session version of the user it was
// issued for. See generateCSRFToken / validateCSRFToken in _utils.js.
// Concretely: pass the session's current version so a token issued
// before a logout/password change stops working right away.
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

  const url = new URL(request.url);
  const requestedType = String(url.searchParams.get('type') || '').toLowerCase().trim();

  try {
    // ---- Explicit guest token ----
    if (requestedType === 'guest') {
      const guest = await getGuestSession(request, env);
      if (guest && guest.userId) {
        const sv = Number(guest.sessionVersion ?? 0);
        const token = await generateCSRFToken(guest.userId, env, sv);
        return jsonResponse(
          { success: true, token, type: 'guest' },
          200, request,
          { 'Cache-Control': 'no-store' }
        );
      }
      return jsonResponse({ error: 'No guest session' }, 401, request);
    }

    // ---- Explicit owner token ----
    if (requestedType === 'owner') {
      const owner = await getOwnerSession(request, env);
      if (owner && owner.ownerId) {
        const sv = Number(owner.ownerSessionVersion ?? 0);
        const token = await generateCSRFToken(owner.ownerId, env, sv);
        return jsonResponse(
          { success: true, token, type: 'owner' },
          200, request,
          { 'Cache-Control': 'no-store' }
        );
      }
      return jsonResponse({ error: 'No owner session' }, 401, request);
    }

    // ---- Legacy: no type specified. Try guest first, then owner. ----
    const guest = await getGuestSession(request, env);
    if (guest && guest.userId) {
      const sv = Number(guest.sessionVersion ?? 0);
      const token = await generateCSRFToken(guest.userId, env, sv);
      return jsonResponse(
        { success: true, token, type: 'guest' },
        200, request,
        { 'Cache-Control': 'no-store' }
      );
    }

    const owner = await getOwnerSession(request, env);
    if (owner && owner.ownerId) {
      const sv = Number(owner.ownerSessionVersion ?? 0);
      const token = await generateCSRFToken(owner.ownerId, env, sv);
      return jsonResponse(
        { success: true, token, type: 'owner' },
        200, request,
        { 'Cache-Control': 'no-store' }
      );
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
