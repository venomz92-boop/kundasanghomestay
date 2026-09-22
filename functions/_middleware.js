// /functions/_middleware.js — ROOT middleware (runs for every request).
//
// [REVISION — 22 Sept 2026 — Phase 3]
//
// Two changes that fix the "another sign-in keeps popping out" bug:
//
//   1. /admin.html and /api/admin-login are NO LONGER behind Basic Auth.
//      - /admin.html is a static shell; all real data comes from
//        authenticated API calls. The page itself shows a login form
//        when there's no admin cookie (see fetchCloudData in admin.html),
//        so Basic Auth on the shell added zero real security.
//      - /api/admin-login behind Basic Auth was a chicken-and-egg bug:
//        if the browser ever forgot the cached Basic creds, the admin
//        could never log back in.
//
//   2. /api/payout, /api/retry-payout, /api/withdraw now accept a valid
//      admin cookie (getAdminSession) as an ALTERNATIVE to Basic Auth.
//      Before: the admin page had a valid cookie but the root middleware
//      only looked at the Authorization header — so every fetch() from
//      the admin page to /api/withdraw triggered the browser's native
//      Basic Auth dialog. That dialog fired on every renderAdmin() call,
//      which is why it appeared right after every delete / approve /
//      reject action.
//
//      Basic Auth still works for external scripts, cron jobs, and curl.
//      Phase 4 will audit withdraw.js / payout.js / retry-payout.js and
//      probably drop Basic Auth entirely.
//
// http → https redirect is now 308 (was 301). 301 rewrites POST → GET
// per RFC and strips the request body.
//
// Credentials still come from Cloudflare env vars:
//   ADMIN_BASIC_USER
//   ADMIN_BASIC_PASS

import { getAdminSession } from './api/_utils.js';

// Money-out endpoints. These stay under the Basic Auth gate (as a
// fallback), but a valid admin cookie also satisfies the gate.
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

// Try to validate the admin cookie. Fail closed on any error.
async function hasValidAdminCookie(request, env) {
  try {
    const admin = await getAdminSession(request, env);
    return !!admin;
  } catch (_) {
    return false;
  }
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

  // ---- 2. Admin gate (money-out endpoints only) ---------------------
  if (isProtected(url.pathname)) {
    // Preferred path: valid admin cookie (no popup, no secrets in URL).
    if (await hasValidAdminCookie(request, env)) {
      return next();
    }

    // Fallback path: Basic Auth (for external scripts / curl).
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
