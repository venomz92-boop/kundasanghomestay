// /api/_middleware.js
//
// Runs for every request under /api/*.
//
// Jobs:
//   1. Force HTTPS on http:// requests.
//   2. GLOBAL CSRF GATE — reject any state-changing request
//      (POST / PUT / DELETE / PATCH) that does not carry a valid
//      CSRF token, UNLESS the endpoint is on a small allow-list of
//      pre-authentication or server-to-server routes.
//   3. Catch and log any 5xx response or uncaught error to the
//      kd_errors store, so the admin panel can display them.
//
// Logging failures NEVER break the response — they are swallowed.

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
// server-to-server, or are harmless (logout). These skip the gate.
const CSRF_EXEMPT_PATHS = new Set([
  // Pre-authentication — user has no session yet
  '/api/login',
  '/api/register',
  '/api/owner-register',
  '/api/owner-login',
  '/api/admin-login',
  '/api/forgot-password',
  '/api/reset-password',
  '/api/verify-email',
  '/api/verify-owner-email',
  // Server-to-server (CHIP signs its own requests)
  '/api/chip-webhook',
  // Logout endpoints — CSRF-forcing a logout is not a security risk
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

  const token = request.headers.get('X-CSRF-Token');
  if (!token) {
    return csrfFailure(
      'CSRF_MISSING',
      'Missing security token. Please refresh the page and try again.'
    );
  }

  // Which session is this request bound to?
  let userId = null;
  try {
    const guest = await getGuestSession(request, env);
    if (guest && guest.userId) userId = String(guest.userId);
  } catch (_) {}

  if (!userId) {
    try {
      const owner = await getOwnerSession(request, env);
      if (owner && owner.ownerId) userId = String(owner.ownerId);
    } catch (_) {}
  }

  if (!userId) {
    // Admin sessions use HttpOnly cookies + SameSite=Lax and, for the
    // most sensitive routes, HTTP Basic Auth at the root middleware.
    // They do not carry a CSRF token. If an admin session is present,
    // let the request through; the endpoint still calls
    // verifyAdminAuth() itself before doing anything.
    try {
      const admin = await getAdminSession(request, env);
      if (admin) return null;
    } catch (_) {}

    return csrfFailure(
      'CSRF_NO_SESSION',
      'No active session for CSRF validation.'
    );
  }

  let ok = false;
  try {
    ok = await validateCSRFToken(token, userId, env);
  } catch (_) {
    ok = false;
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
// Error logging (unchanged from before)
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
