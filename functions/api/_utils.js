// /api/_utils.js
export const MAX_BODY_SIZE = 1024 * 1024;

// === CLOUDINARY CLEANUP ===
export async function deleteFromCloudinary(publicId, env) {
  if (!publicId || !env.CLOUDINARY_API_SECRET) return;
  const auth = btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`);
  try {
    await fetch(
      `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/image/upload?public_ids[]=${encodeURIComponent(publicId)}`,
      { method: 'DELETE', headers: { 'Authorization': `Basic ${auth}` } }
    );
  } catch (e) { console.error('Cloudinary Delete Error:', e.message); }
}

// === AUTHENTICATION & TOKENS ===
export async function createSignedToken(payload, env, ttlMs = 86400000) {
  const secret = env.SESSION_SECRET;
  const body = { ...payload, exp: Date.now() + ttlMs };
  const encoded = btoa(JSON.stringify(body)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const signature = await hmacSign(encoded, secret);
  return `${encoded}.${signature}`;
}

async function hmacSign(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function verifySignedToken(token, env) {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  try {
    const payload = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// === PASSWORD SECURITY ===
export async function hashPassword(password, env) {
  const salt = crypto.randomUUID();
  const msgBuffer = new TextEncoder().encode(env.SESSION_SECRET + password + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { hash, salt, algorithm: 'SHA-256-V2' };
}

// === HTTP & CORS ===
export function corsHeaders(request) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Owner-Authorization, X-CSRF-Token'
  };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function logAction(db, action, details, ip, userId) {
  await db.prepare("INSERT INTO audit_log (timestamp, action, details, ip, user_id) VALUES (?, ?, ?, ?, ?)")
    .bind(new Date().toISOString(), action, details, ip, userId).run();
}
