// /functions/api/lib/http.js
// HTTP utilities: request parsing, response helpers, cookies, CORS

export const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Get Bearer token from Authorization header
 * @param {Request} request 
 * @param {string} headerName - Header name (default: 'Authorization')
 * @returns {string|null}
 */
export function getBearerToken(request, headerName = 'Authorization') {
  const auth = request.headers.get(headerName) || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

/**
 * Get cookie value from request
 * @param {Request} request 
 * @param {string} name 
 * @returns {string|null}
 */
export function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Create Set-Cookie header value
 * @param {string} name 
 * @param {string} value 
 * @param {number} maxAge - Max age in seconds
 * @param {string} sameSite - SameSite attribute
 * @returns {string}
 */
export function cookieHeader(name, value, maxAge = 86400, sameSite = 'Lax') {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}; Path=/`;
}

/**
 * Create cookie clear header
 * @param {string} name 
 * @param {string} sameSite 
 * @returns {string}
 */
export function clearCookieHeader(name, sameSite = 'Lax') {
  return `${name}=; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=0; Path=/`;
}

/**
 * Get client IP from request headers
 * @param {Request} request 
 * @returns {string}
 */
export function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || 
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
         'unknown';
}

/**
 * Get CORS headers for response
 * @param {Request} request 
 * @returns {Object}
 */
export function corsHeaders(request) {
  const allowed = new Set([
    'https://kundasanghomestay.my',
    'https://kundasanghomestay.pages.dev',
    'http://localhost:5173'
  ]);
  const origin = request?.headers?.get('Origin') || '';
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Owner-Authorization, X-CSRF-Token',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.tailwindcss.com https://gate.chip-in.asia https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https://*.wikimedia.org https://images.unsplash.com https://res.cloudinary.com",
      "connect-src 'self' https://api.chip-in.asia https://gate.chip-in.asia https://api.resend.com https://api.sendgrid.com https://api.cloudinary.com https://api.open-meteo.com https://cloudflareinsights.com",
      "frame-src 'self' https://gate.chip-in.asia",
      "base-uri 'self'",
      "form-action 'self' https://gate.chip-in.asia"
    ].join('; ') + ';',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload'
  };
  if (allowed.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/**
 * Enforce HTTPS redirect
 * @param {Request} request 
 * @returns {Response|null}
 */
export function enforceHttps(request) {
  const url = new URL(request.url);
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return new Response(null, { status: 301, headers: { Location: url.toString() } });
  }
  return null;
}

/**
 * Create JSON response
 * @param {Object} body 
 * @param {number} status 
 * @param {Request} request 
 * @param {Object} extra - Extra headers
 * @returns {Response}
 */
export function jsonResponse(body, status, request, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), ...extra }
  });
}

/**
 * Create error JSON response
 * @param {string} message 
 * @param {number} status 
 * @param {Request} request 
 * @param {Object} logDetails 
 * @returns {Response}
 */
export function errorResponse(message, status, request, logDetails = null) {
  return jsonResponse(
    { error: message || 'An unexpected error occurred. Please try again later.' }, 
    status, 
    request
  );
}

/**
 * Parse JSON from request safely with size limit
 * @param {Request} request 
 * @returns {Promise<Object>}
 * @throws {Error}
 */
export async function parseJSONSafely(request) {
  const cl = request.headers.get('Content-Length');
  if (cl !== null) {
    const declared = parseInt(cl, 10);
    if (!isNaN(declared) && declared > MAX_BODY_SIZE) {
      throw new Error('Payload too large');
    }
  }
  const text = await request.text();
  if (text.length > MAX_BODY_SIZE) {
    throw new Error('Payload too large');
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('Invalid JSON');
  }
}

/**
 * Get CSRF token from request header
 * @param {Request} request 
 * @returns {string|null}
 */
export function getCSRFToken(request) {
  return request.headers.get('X-CSRF-Token') || null;
}
