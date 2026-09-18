// /api/csrf-token.js — Issues a fresh CSRF token for the account type
// the caller asks for.
//
// [THIS REVISION]
// Accepts an optional ?type=guest or ?type=owner query parameter. When
// specified, only that session is consulted. Without a type, falls back
// to the legacy behaviour (try guest first, then owner).
//
// Why: when a browser has BOTH a guest cookie and an owner cookie (which
// happens if you ever log in as guest, then as owner without logging the
// guest out), the legacy endpoint returns the guest token. Owner-only
// actions then fail with "Invalid security token" because the guest token
// belongs to a different user ID. Explicit ?type=owner fixes that.
import {
  corsHeaders,
  enforceHttps,
  getGuestSession,
  getOwnerSession,
  generateCSRFToken,
  jsonResponse
} from '../lib/index.js';

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
        const token = await generateCSRFToken(guest.userId, env);
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
        const token = await generateCSRFToken(owner.ownerId, env);
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
      const token = await generateCSRFToken(guest.userId, env);
      return jsonResponse(
        { success: true, token, type: 'guest' },
        200, request,
        { 'Cache-Control': 'no-store' }
      );
    }

    const owner = await getOwnerSession(request, env);
    if (owner && owner.ownerId) {
      const token = await generateCSRFToken(owner.ownerId, env);
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
