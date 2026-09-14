// /api/_middleware.js
//
// Runs for every request under /api/*.
//
// Jobs:
//   1. Force HTTPS on http:// requests.
//   2. GLOBAL CSRF GATE — reject any state-changing request
//      (POST / PUT / DELETE / PATCH) that does not carry a valid
//      CSRF token, UNLESS:
//        (a) the endpoint is on the pre-auth / server-to-server
//            allow-list below, OR
//        (b) an authenticated ADMIN session is present (admins are
//            protected by HTTP Basic Auth at the root middleware
//            and their HttpOnly SameSite=Lax cookie).
//   3. Catch and log any 5xx response or uncaught error to the
//      kd_errors store, so the admin panel can display them.
//
// [THIS REVISION]
// Added an owner-session fallback to the CSRF gate. Scenario that
// broke without it:
//
//   1. User logs in as a guest. Browser receives guest_token cookie.
//   2. User registers as a host and verifies email. Browser receives
//      owner_token cookie. Guest cookie is still present.
//   3. User visits /list.html or /owner.html. csrf-auto.js sends an
//      OWNER CSRF token on every mutating request (it picks the token
//      type from the URL path).
//   4. The gate above picks the guest session first because it checks
//      guest before owner. It then validates the owner token against
//      the guest user ID → mismatch → 403 CSRF_INVALID.
//
// The fallback below tries the owner session if the guest session
// check fails. The token is still signed with SESSION_SECRET and
// still carries a userId inside it, so a guest token cannot
// impersonate an owner or vice versa — we only accept the token if
// it matches one of the two sessions the browser actually holds.

import {
  getGuestSession,
  getOwnerSession,
  getAdminSession,
  validateCSRFToken
} from './_utils.js';

const ERRORS_KEY = 'kd_errors';
const MAX_ERRORS = 200;
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// CSRF GATE
// ---------------------------------------------------------------------------
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// Routes that must be reachable BEFORE a session exists, are
// server-to-server, or are harmless (logout).
const CSRF_EXEMPT_PATHS = new Set([
  '/api/login',
  '/api/register',
  '/api/owner-register',
  '/api/owner-login',
  '/api/admin-login',
  '/api/forgot-password',
  '/api/reset-password',
  '/api/verify-email',
  '/api/verify-owner-email',
  '/api/chip-webhook',
  '/api/logout',
  '/api/owner-logout',
  '/api/admin-logout'
]);

function normaliseApiPath(p) {
  return String(p || '').replace(/\.js$/i, '').replace(/\/+$/, '') || '/';
}

function csrfFailure(code, message) {
  return new Response(JSON.stringify({ error: message, code }), {
    status: 403,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function enforceCSRFGate(request, env) {
  const method = String(request.method || 'GET').toUpperCase();
  if (!MUTATING_METHODS.has(method)) return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;

  const clean = normaliseApiPath(url.pathname);
  if (CSRF_EXEMPT_PATHS.has(clean)) return null;

  // ---- 1. ADMIN SESSION BYPASS -------------------------------------------
  // Admins authenticate via HttpOnly SameSite=Lax cookie + HTTP Basic
  // Auth at the root middleware. They do not carry a CSRF token.
  // Check this FIRST so admin actions are never blocked.
  try {
    const admin = await getAdminSession(request, env);
    if (admin) return null;
  } catch (_) {}

  // ---- 2. Everything else must present a valid CSRF token ----------------
  const token = request.headers.get('X-CSRF-Token');
  if (!token) {
    return csrfFailure(
      'CSRF_MISSING',
      'Missing security token. Please refresh the page and try again.'
    );
  }

  // ---- 3. Resolve the caller's session(s) --------------------------------
  let guestUserId = null;
  try {
    const guest = await getGuestSession(request, env);
    if (guest && guest.userId) guestUserId = String(guest.userId);
  } catch (_) {}

  let ownerUserId = null;
  try {
    const owner = await getOwnerSession(request, env);
    if (owner && owner.ownerId) ownerUserId = String(owner.ownerId);
  } catch (_) {}

  if (!guestUserId && !ownerUserId) {
    return csrfFailure(
      'CSRF_NO_SESSION',
      'No active session for CSRF validation.'
    );
  }

  // ---- 4. Try the token against whichever session(s) are present ---------
  // Previously this only checked the guest session first and stopped there.
  // Now we try BOTH sessions so a user who holds two cookies (guest +
  // owner) is not locked out of host-only pages.
  let ok = false;

  if (guestUserId) {
    try {
      ok = await validateCSRFToken(token, guestUserId, env);
    } catch (_) {
      ok = false;
    }
  }

  if (!ok && ownerUserId) {
    try {
      ok = await validateCSRFToken(token, ownerUserId, env);
    } catch (_) {
      ok = false;
    }
  }

  if (!ok) {
    return csrfFailure(
      'CSRF_INVALID',
      'Invalid or expired security token. Please refresh the page and try again.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Error logging (unchanged)
// ---------------------------------------------------------------------------
function shortenStack(stack) {
  if (!stack || typeof stack !== 'string') return '';
  return stack.slice(0, 2000);
}

function signatureFor(method, endpoint, message) {
  const m = String(message || '').slice(0, 200);
  return `${method}::${endpoint}::${m}`;
}

async function logApiError(context, info) {
  const { env, waitUntil } = context;
  if (!env || !env.DB) return;

  const work = (async () => {
    try {
      const db = env.DB;
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(ERRORS_KEY).first();
      let errors = [];
      try { if (r?.data) errors = JSON.parse(r.data); } catch (_) {}
      if (!Array.isArray(errors)) errors = [];

      const sig = signatureFor(info.method, info.endpoint, info.message);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();

      const idx = errors.findIndex(e => {
        if (e.signature !== sig) return false;
        const last = e.last_seen ? new Date(e.last_seen).getTime() : 0;
        return (now - last) < DEDUPE_WINDOW_MS;
      });

      if (idx !== -1) {
        errors[idx].count = (errors[idx].count || 1) + 1;
        errors[idx].last_seen = nowIso;
      } else {
        errors.push({
          id: 'ERR-' + now + '-' + Math.random().toString(36).slice(2, 8),
          signature: sig,
          method: info.method || 'GET',
          endpoint: info.endpoint || '/',
          status: info.status || 500,
          message: String(info.message || 'Unknown error').slice(0, 500),
          sample_stack: shortenStack(info.stack || ''),
          sample_ip: String(info.ip || 'unknown').slice(0, 45),
          count: 1,
          first_seen: nowIso,
          last_seen: nowIso
        });
      }

      if (errors.length > MAX_ERRORS) {
        errors = errors
          .slice()
          .sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0))
          .slice(0, MAX_ERRORS);
      }

      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind(ERRORS_KEY, JSON.stringify(errors))
        .run();
    } catch (_) {}
  })();

  if (typeof waitUntil === 'function') waitUntil(work);
  else await work;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // 1. Force HTTPS
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return new Response(null, {
      status: 301,
      headers: { Location: url.toString() }
    });
  }

  // 2. GLOBAL CSRF GATE
  const csrfBlock = await enforceCSRFGate(request, env);
  if (csrfBlock) return csrfBlock;

  // 3. Skip logging for the errors endpoint itself
  if (url.pathname === '/api/admin-errors') return next();

  const clientIP =
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown';

  try {
    const response = await next();

    if (response && response.status >= 500) {
      let message = 'Server error';
      try {
        const clone = response.clone();
        const text = await clone.text();
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed.error === 'string') message = parsed.error;
            else if (parsed && typeof parsed.message === 'string') message = parsed.message;
          } catch (_) {
            message = text.slice(0, 200);
          }
        }
      } catch (_) {}

      await logApiError(context, {
        method: request.method,
        endpoint: url.pathname,
        status: response.status,
        message, stack: '', ip: clientIP
      });
    }

    return response;
  } catch (err) {
    const message = (err && err.message) ? err.message : String(err);
    await logApiError(context, {
      method: request.method,
      endpoint: url.pathname,
      status: 500,
      message,
      stack: err && err.stack ? err.stack : '',
      ip: clientIP
    });
    throw err;
  }
}
