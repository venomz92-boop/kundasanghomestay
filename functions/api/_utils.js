// /functions/api/_utils.js
// ===== SHARED HELPERS – with rate limiting additions =====

// === PBKDF2 constants ===
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH = 'SHA-256';
const PBKDF2_KEYLEN = 256;

// === Encoding helpers ===
function b64urlEncode(input) {
  let bytes;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else bytes = input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecodeToBytes(value) {
  const s = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function b64urlDecode(value) {
  return new TextDecoder().decode(b64urlDecodeToBytes(value));
}

async function hmacSign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return b64urlEncode(new Uint8Array(sig));
}

async function hmacVerify(value, signature, secret) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      'HMAC', key,
      b64urlDecodeToBytes(signature),
      new TextEncoder().encode(value)
    );
  } catch (_) {
    return false;
  }
}

function requireSessionSecret(env) {
  const secret = env?.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET is missing or too short');
  }
  return secret;
}

// === TOKEN CREATION (with TTL) ===
export async function createSignedToken(payload, env, ttlMs = 24 * 60 * 60 * 1000) {
  const secret = requireSessionSecret(env);
  const body = { ...payload, iat: Date.now(), exp: Date.now() + ttlMs };
  const encoded = b64urlEncode(JSON.stringify(body));
  const signature = await hmacSign(encoded, secret);
  return `${encoded}.${signature}`;
}

// === ADMIN TOKEN (shorter TTL) ===
export async function createAdminToken(payload, env) {
  return createSignedToken(payload, env, 8 * 60 * 60 * 1000);
}

export async function verifySignedToken(token, env) {
  if (!token || typeof token !== 'string') return null;
  const firstDot = token.indexOf('.');
  if (firstDot <= 0) return null;
  const encoded = token.slice(0, firstDot);
  const signature = token.slice(firstDot + 1);
  if (!signature) return null;

  try {
    const secret = requireSessionSecret(env);
    if (!(await hmacVerify(encoded, signature, secret))) return null;
    const payload = JSON.parse(b64urlDecode(encoded));
    if (!payload || !payload.exp || Date.now() >= Number(payload.exp)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// === User session helpers ===
async function getUserRecord(type, userId, db) {
  if (type === 'guest') {
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch(_) {}
    return guests.find(g => String(g.id) === String(userId)) || null;
  } else if (type === 'owner') {
    const approved = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
    const pending = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
    let homes = [];
    try { if (approved?.data) homes = homes.concat(JSON.parse(approved.data)); } catch(_) {}
    try { if (pending?.data) homes = homes.concat(JSON.parse(pending.data)); } catch(_) {}
    return homes.find(h => String(h.id) === String(userId)) || null;
  }
  return null;
}

export async function getGuestSession(request, env) {
  const token = getBearerToken(request) || getCookie(request, 'guest_token');
  if (!token) return null;
  const payload = await verifySignedToken(token, env);
  if (!payload || payload.type !== 'guest') return null;

  const db = env.DB;
  if (!db) return null;
  await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
  const record = await getUserRecord('guest', payload.userId, db);
  if (!record) return null;
  if (record.passwordVersion !== undefined && payload.passwordVersion !== undefined) {
    if (Number(record.passwordVersion) !== Number(payload.passwordVersion)) return null;
  }
  return payload;
}

export async function getOwnerSession(request, env) {
  const token = getBearerToken(request, 'Owner-Authorization') || getCookie(request, 'owner_token');
  if (!token) return null;
  const payload = await verifySignedToken(token, env);
  if (!payload || payload.type !== 'owner') return null;

  const db = env.DB;
  if (!db) return null;
  await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
  const record = await getUserRecord('owner', payload.ownerId, db);
  if (!record) return null;
  if (record.ownerPasswordVersion !== undefined && payload.passwordVersion !== undefined) {
    if (Number(record.ownerPasswordVersion) !== Number(payload.passwordVersion)) return null;
  }
  return payload;
}

// === HTTP helpers ===
export function getBearerToken(request, headerName = 'Authorization') {
  const auth = request.headers.get(headerName) || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

export function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export function cookieHeader(name, value, maxAge = 86400) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}; Path=/`;
}

export function clearCookieHeader(name) {
  return `${name}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/`;
}

// === Password hashing ===
export function generateSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return b64urlEncode(bytes);
}

async function derivePassword(password, salt, pepper, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${pepper}${password}`),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations, hash: PBKDF2_HASH },
    material,
    PBKDF2_KEYLEN
  );
  return b64urlEncode(new Uint8Array(bits));
}

export async function hashPassword(password, env, salt = generateSalt()) {
  const pepper = env?.PASSWORD_PEPPER || env?.SESSION_SECRET;
  if (!pepper) throw new Error('PASSWORD_PEPPER or SESSION_SECRET is required');
  const algorithm = `PBKDF2-${PBKDF2_ITERATIONS}-SHA256`;
  return {
    hash: await derivePassword(password, salt, pepper, PBKDF2_ITERATIONS),
    salt,
    algorithm
  };
}

export async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password, record, env) {
  if (!record?.password && !record?.ownerPasswordHash) return { ok: false, legacy: false };
  const hash = record.password || record.ownerPasswordHash;
  const salt = record.salt || record.ownerSalt || '';
  const algorithm = record.passwordAlgorithm || record.ownerPasswordAlgorithm;
  const pepper = env?.PASSWORD_PEPPER || env?.SESSION_SECRET;
  if (!pepper) return { ok: false, legacy: false };

  if (algorithm && algorithm.startsWith('PBKDF2-')) {
    const parts = algorithm.split('-');
    const iterations = parts.length >= 2 ? parseInt(parts[1], 10) : PBKDF2_ITERATIONS;
    if (isNaN(iterations) || iterations <= 0) {
      const computed = await derivePassword(password, salt, pepper, PBKDF2_ITERATIONS);
      return { ok: computed === hash, legacy: false };
    }
    const computed = await derivePassword(password, salt, pepper, iterations);
    return { ok: computed === hash, legacy: false };
  }

  const legacyPepper = env?.LEGACY_PASSWORD_PEPPER || env?.PASSWORD_PEPPER || 'kundasang-homestay-2026';
  const computedLegacy = await sha256(legacyPepper + password + salt);
  return { ok: computedLegacy === hash, legacy: true };
}

// === IP / CORS / HTTPS ===
export function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
}

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Owner-Authorization, X-CSRF-Token, X-Toyyibpay-Secret',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
  if (allowed.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

export function enforceHttps(request) {
  const url = new URL(request.url);
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  return null;
}

// === Audit logging ===
export async function logAction({ db, action, admin, details, ip, userId, homestayId }) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT, action TEXT, admin TEXT, user_id TEXT,
      homestay_id TEXT, details TEXT, ip TEXT
    )`).run();
    await db.prepare(`INSERT INTO audit_log
      (timestamp, action, admin, user_id, homestay_id, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(new Date().toISOString(), action, admin || 'system', userId || null,
        homestayId || null, details || '', ip || 'unknown').run();
    return true;
  } catch (e) {
    console.error('Audit log failed:', e.message);
    return false;
  }
}

// === CSRF ===
export async function generateCSRFToken(userId, env) {
  return createSignedToken({ type: 'csrf', userId: String(userId) }, env, 24 * 60 * 60 * 1000);
}

export async function validateCSRFToken(token, userId, env) {
  const data = await verifySignedToken(token, env);
  return !!data && data.type === 'csrf' && String(data.userId) === String(userId);
}

export function getCSRFToken(request) {
  return request.headers.get('X-CSRF-Token') || null;
}

// === Admin token retrieval ===
export async function getAdminToken(request) {
  return getBearerToken(request) || getCookie(request, 'admin_token');
}

// === JSON responses ===
export function jsonResponse(body, status, request, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), ...extra }
  });
}

export function errorResponse(message, status, request, logDetails = null) {
  if (logDetails) console.error('Error details:', logDetails);
  return jsonResponse({ error: message || 'An unexpected error occurred. Please try again later.' }, status, request);
}

// =============================================================
// ★ NEW: PERSISTENT RATE LIMITING (D1-based) ★
// =============================================================

/**
 * Creates the rate_limits table if it does not exist.
 */
export async function ensureRateLimitTable(db) {
  if (!db) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS rate_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      action TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )`
  ).run();
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_rate_limits_ip_action ON rate_limits(ip, action)`
  ).run();
}

/**
 * Checks if the given IP is allowed to perform the action.
 * Returns true if under the limit, false if blocked.
 */
export async function checkRateLimit(db, ip, action, maxAttempts, windowSeconds = 60) {
  if (!db || !ip) return true;
  try {
    await ensureRateLimitTable(db);
    const now = Date.now();
    const cutoff = now - windowSeconds * 1000;
    const res = await db.prepare(
      `SELECT COUNT(*) as count FROM rate_limits 
       WHERE ip = ? AND action = ? AND timestamp > ?`
    ).bind(ip, action, cutoff).first();
    const count = res?.count || 0;
    return count < maxAttempts;
  } catch (e) {
    console.error('Rate limit check error:', e);
    return true;
  }
}

/**
 * Records a new rate‑limit attempt for the IP + action.
 */
export async function recordRateLimit(db, ip, action) {
  if (!db || !ip) return;
  try {
    await ensureRateLimitTable(db);
    const now = Date.now();
    await db.prepare(
      `INSERT INTO rate_limits (ip, action, timestamp) VALUES (?, ?, ?)`
    ).bind(ip, action, now).run();
    const cutoff = now - 24 * 60 * 60 * 1000;
    await db.prepare(
      `DELETE FROM rate_limits WHERE timestamp < ?`
    ).bind(cutoff).run();
  } catch (e) {
    console.error('Rate limit record error:', e);
  }
}
