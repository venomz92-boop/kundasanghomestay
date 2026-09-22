// /functions/_middleware.js — ROOT middleware (runs for every request).
//
// Two jobs:
//   1. Force HTTPS on any http:// request.
//   2. Ask for a username + password before serving the admin panel
//      or any admin-only API route.
//
// Everything else (homepage, images, guest API, owner API, etc.)
// passes straight through untouched.
//
// Credentials come from Cloudflare env vars:
//   ADMIN_BASIC_USER
//   ADMIN_BASIC_PASS
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - http → https redirect is now 308 (was 301). 301 rewrites POST→GET
//   per RFC and would strip the request body on any http:// POST.
// - Protected surface is now PREFIX-based for admin APIs:
//   any path starting with /api/admin- is protected, EXCEPT the two
//   endpoints below that must remain reachable. Previously only 5
//   exact paths were listed, so any /api/admin-* endpoint added
//   later silently bypassed the gate entirely.
// - /api/admin-login is explicitly EXEMPT. Protecting it was a
//   chicken-and-egg bug: if the browser ever forgot the cached
//   Basic Auth creds, the admin could never log back in because the
//   login endpoint itself demanded Basic Auth first. Rate limiting
//   on admin-login.js handles brute force.
// - /api/admin-logout is explicitly EXEMPT. It only clears the admin
//   cookie; the worst anyone can do by calling it is log themselves out.
// - /admin.html and its trailing-slash form are both protected.
//
// NOTE: /api/payout, /api/retry-payout, /api/withdraw are kept under
// Basic Auth for now (same as before). Phase 4 will revisit whether
// those should really be Basic-Auth-gated or cookie-gated.

const PROTECTED_EXACT_PATHS = new Set([
  '/admin.html'
]);

// Any path starting with one of these prefixes is protected,
// unless it is listed in PROTECTED_EXEMPT below.
const PROTECTED_PREFIXES = [
  '/api/admin-'
];

// Under /api/admin-* but must remain reachable without Basic Auth.
const PROTECTED_EXEMPT = new Set([
  '/api/admin-login',
  '/api/admin-logout'
]);

// Legacy exact paths that were protected before and we keep for now.
const PROTECTED_LEGACY_PATHS = new Set([
  '/api/payout',
  '/api/retry-payout',
  '/api/withdraw'
]);

function isProtected(pathname) {
  // Normalise trailing slash so /admin.html/ still matches.
  const clean = pathname.replace(/\/+$/, '') || '/';

  if (PROTECTED_EXEMPT.has(clean)) return false;
  if (PROTECTED_EXACT_PATHS.has(clean)) return true;
  if (PROTECTED_LEGACY_PATHS.has(clean)) return true;

  for (const prefix of PROTECTED_PREFIXES) {
    if (clean.startsWith(prefix)) return true;
  }

  return false;
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
  // 308 preserves the method and body (301 does not).
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return new Response(null, {
      status: 308,
      headers: { Location: url.toString() }
    });
  }

  // ---- 2. Admin gate ------------------------------------------------
  if (isProtected(url.pathname)) {
    const expectedUser = env.ADMIN_BASIC_USER;
    const expectedPass = env.ADMIN_BASIC_PASS;

    if (!expectedUser || !expectedPass) {
      console.error(
        'CRITICAL: ADMIN_BASIC_USER or ADMIN_BASIC_PASS is not set. ' +
        'Refusing all admin requests.'
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
