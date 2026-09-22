// /functions/_middleware.js — ROOT middleware (runs for every request).
//
// [REVISION — 22 Sept 2026 — Phase 3]
//
// Basic Auth gate REMOVED for /admin.html and /api/admin-login.
//
// Why:
//   1. Two admin secrets is a footgun (handoff issue #3). The admin
//      cookie set by /api/admin-login is now the single source of truth
//      for admin identity. Every admin API endpoint validates it via
//      getAdminSession() from _utils.js.
//   2. The Basic Auth layer on /admin.html caused the browser's native
//      sign-in dialog to re-prompt unpredictably (page reload after a
//      delete, new tab, Safari session handling) — the "another sign
//      in keeps popping out" bug. /admin.html is a static shell that
//      contains no secrets; all real data comes from authenticated API
//      calls, so Basic Auth on the shell added zero real security.
//   3. /api/admin-login behind Basic Auth was a chicken-and-egg bug:
//      if the browser forgot the cached Basic creds, the admin could
//      never log back in because the login endpoint demanded Basic
//      Auth first. admin-login.js has its own per-IP + global rate
//      limiting to stop brute force.
//
// /api/payout, /api/retry-payout, /api/withdraw are still behind Basic
// Auth for now — they will be reviewed in Phase 4. Do not remove them
// from the protected list until those files are audited.
//
// http → https redirect is now 308 (was 301). 301 rewrites POST → GET
// per RFC and strips the request body on any http:// POST.

const PROTECTED_EXACT_PATHS = new Set([
  '/api/payout',
  '/api/retry-payout',
  '/api/withdraw'
]);

function isProtected(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return PROTECTED_EXACT_PATHS.has(clean);
}

// Constant-time string comparison using Web Crypto.
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);

  const hashA = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bufA)
  );
  const hashB = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bufB)
  );

  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0;
}

function decodeBasicAuth(headerValue) {
  if (!headerValue || !headerValue.startsWith('Basic ')) return null;
  const b64 = headerValue.slice(6).trim();
  try {
    const decoded = atob(b64);
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    return {
      user: decoded.slice(0, colon),
      pass: decoded.slice(colon + 1)
    };
  } catch (_) {
    return null;
  }
}

function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Admin", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow'
    }
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // ---- 1. Force HTTPS -----------------------------------------------
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return new Response(null, {
      status: 308,
      headers: { Location: url.toString() }
    });
  }

  // ---- 2. Basic Auth gate (money-out endpoints only, Phase 4 will
  //         revisit whether these should be cookie-gated too) --------
  if (isProtected(url.pathname)) {
    const expectedUser = env.ADMIN_BASIC_USER;
    const expectedPass = env.ADMIN_BASIC_PASS;

    if (!expectedUser || !expectedPass) {
      console.error(
        'CRITICAL: ADMIN_BASIC_USER or ADMIN_BASIC_PASS is not set. ' +
        'Refusing all money-out requests.'
      );
      return new Response('Admin is not configured on this server.', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }

    const provided = decodeBasicAuth(request.headers.get('Authorization'));
    if (!provided) return unauthorized();

    const userOk = await timingSafeEqual(provided.user, expectedUser);
    const passOk = await timingSafeEqual(provided.pass, expectedPass);

    if (!userOk || !passOk) return unauthorized();
  }

  // ---- 3. Everything else passes through ---------------------------
  return next();
}
