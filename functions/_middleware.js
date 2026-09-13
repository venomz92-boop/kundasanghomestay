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

const PROTECTED_EXACT_PATHS = new Set([
  '/admin.html',
  '/api/admin-login',
  '/api/admin-logout',
  '/api/payout',
  '/api/retry-payout',
  '/api/withdraw'
]);

function isProtected(pathname) {
  // Normalise trailing slash so /admin.html/ still matches.
  const clean = pathname.replace(/\/+$/, '') || '/';
  return PROTECTED_EXACT_PATHS.has(clean);
}

// Constant-time string comparison using Web Crypto.
// Returns true only when the two strings are byte-for-byte identical.
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);

  // Hash both sides first so the comparison loop always runs the
  // same number of iterations regardless of input length.
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
  // headerValue looks like: "Basic bmljazpzZWNyZXQ="
  if (!headerValue || !headerValue.startsWith('Basic ')) return null;
  const b64 = headerValue.slice(6).trim();
  try {
    const decoded = atob(b64);
    // Split at the FIRST colon only — passwords may contain colons.
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
      status: 301,
      headers: { Location: url.toString() }
    });
  }

  // ---- 2. Admin gate ------------------------------------------------
  if (isProtected(url.pathname)) {
    const expectedUser = env.ADMIN_BASIC_USER;
    const expectedPass = env.ADMIN_BASIC_PASS;

    // If either secret is missing, refuse to serve admin at all.
    // This prevents a "fail open" where a misconfigured deploy
    // accidentally exposes the admin panel to the whole internet.
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
