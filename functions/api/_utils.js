// ===== SHARED HELPERS – Complete (all exports) =====

export const MAX_BODY_SIZE = 1024 * 1024; // 1MB

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
    ['sign']
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
  if (record.sessionVersion !== undefined && payload.sessionVersion !== undefined) {
    if (Number(record.sessionVersion) !== Number(payload.sessionVersion)) return null;
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
  if (record.ownerSessionVersion !== undefined && payload.ownerSessionVersion !== undefined) {
    if (Number(record.ownerSessionVersion) !== Number(payload.ownerSessionVersion)) return null;
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

/**
 * Build a Set-Cookie header string.
 * Default SameSite=Lax because payment gateways (CHIP) redirect the user cross-site
 * back to our domain and Strict would drop the cookie.
 */
export function cookieHeader(name, value, maxAge = 86400, sameSite = 'Lax') {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}; Path=/`;
}

export function clearCookieHeader(name, sameSite = 'Lax') {
  return `${name}=; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=0; Path=/`;
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

  // Legacy SHA-256
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
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://cdn.tailwindcss.com https://gate.chip-in.asia; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://upload.wikimedia.org https://i.ibb.co https://www.clladventureborneo.com https://blogger.googleusercontent.com https://lh3.googleusercontent.com https://explorekundasang.com; connect-src 'self' https://api.chip-in.asia; frame-src 'self';",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload'
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
  return jsonResponse({ error: message || 'An unexpected error occurred. Please try again later.' }, status, request);
}

// ===== SAFE JSON PARSING WITH SIZE LIMIT =====
export async function parseJSONSafely(request) {
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

// ===== RATE LIMITING (Persistent D1) =====
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
    return true;
  }
}

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
    // silent
  }
}

// ===== SESSION VERSION MANAGEMENT =====
export async function incrementSessionVersion(db, userId, type) {
  if (type === 'guest') {
    const key = 'kd_guests';
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
    let records = [];
    if (r?.data) { try { records = JSON.parse(r.data); } catch(_) {} }
    let changed = false;
    records = records.map(record => {
      if (String(record.id) === String(userId)) {
        changed = true;
        record.sessionVersion = (record.sessionVersion || 0) + 1;
      }
      return record;
    });
    if (changed) {
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind(key, JSON.stringify(records)).run();
    }
    return changed;
  } else if (type === 'owner') {
    return incrementOwnerSessionVersion(db, userId);
  }
  return false;
}

// =============================================================
// FIXED: incrementOwnerSessionVersion now matches by WhatsApp identity.
// Input may be a homestay ID OR a WhatsApp number. We resolve to a WhatsApp
// and bump ownerSessionVersion for EVERY homestay owned by that WhatsApp.
// =============================================================
export async function incrementOwnerSessionVersion(db, ownerIdOrWhatsapp) {
  const input = String(ownerIdOrWhatsapp || '').trim();
  if (!input) return false;

  // Step 1: try to find the homestay by ID to learn its WhatsApp
  let whatsapp = null;
  for (const key of ['kd_approved', 'kd_pending']) {
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
    if (!r?.data) continue;
    let records = [];
    try { records = JSON.parse(r.data); } catch (_) { continue; }
    const found = records.find(x => String(x.id) === input);
    if (found && found.whatsapp) {
      whatsapp = String(found.whatsapp).replace(/[^0-9]/g, '');
      break;
    }
  }
  // If no homestay matched, treat the input as a WhatsApp number directly
  if (!whatsapp) {
    whatsapp = input.replace(/[^0-9]/g, '');
  }
  if (!whatsapp) return false;

  // Step 2: bump session version for every homestay sharing this WhatsApp
  let changed = false;
  for (const key of ['kd_approved', 'kd_pending']) {
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
    if (!r?.data) continue;
    let records = JSON.parse(r.data);
    let updated = false;
    records = records.map(record => {
      const recWa = String(record.whatsapp || '').replace(/[^0-9]/g, '');
      if (recWa === whatsapp) {
        updated = true;
        changed = true;
        record.ownerSessionVersion = (record.ownerSessionVersion || 0) + 1;
      }
      return record;
    });
    if (updated) {
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind(key, JSON.stringify(records)).run();
    }
  }
  return changed;
}

// =============================================================
// VALIDATION HELPERS
// =============================================================

export function sanitizeString(str, maxLen = 200) {
  if (!str) return '';
  return String(str).replace(/[<>]/g, '').trim().slice(0, maxLen);
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).toLowerCase().trim());
}

export function isValidPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

export function isValidPrice(price) {
  const num = Number(price);
  return Number.isFinite(num) && num > 0 && num < 100000;
}

export function sanitizeDescription(desc) {
  if (!desc) return '';
  return String(desc)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<img[^>]*onerror\s*=[^>]*>/gi, '')
    .replace(/<[^>]*on\w+\s*=\s*["'][^"']*["'][^>]*>/gi, '')
    .trim()
    .slice(0, 2000);
}

export function validateBankCode(code) {
  if (!code) return '';
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
}

export function sanitizeArray(arr, maxItems = 20) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxItems);
}

// =============================================================
// Check‑in attempt tracking
// =============================================================
async function ensureCheckinAttemptsTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS checkin_attempts (
      booking_id TEXT,
      attempt_time INTEGER,
      PRIMARY KEY (booking_id, attempt_time)
    )`
  ).run();
}

export async function recordCheckinAttempt(db, bookingId) {
  await ensureCheckinAttemptsTable(db);
  await db.prepare(
    `INSERT INTO checkin_attempts (booking_id, attempt_time) VALUES (?, ?)`
  ).bind(bookingId, Date.now()).run();
}

export async function getRecentCheckinAttempts(db, bookingId, windowMs = 3600000) {
  await ensureCheckinAttemptsTable(db);
  const cutoff = Date.now() - windowMs;
  const result = await db.prepare(
    `SELECT COUNT(*) as count FROM checkin_attempts
     WHERE booking_id = ? AND attempt_time > ?`
  ).bind(bookingId, cutoff).first();
  return result?.count || 0;
}

export async function clearCheckinAttempts(db, bookingId) {
  await ensureCheckinAttemptsTable(db);
  await db.prepare(
    `DELETE FROM checkin_attempts WHERE booking_id = ?`
  ).bind(bookingId).run();
}

// =============================================================
// FIXED: Invalidate owner sessions on homestay changes.
// Input is a homestay ID; we resolve it to the owning WhatsApp and bump
// every sibling homestay so the owner is logged out everywhere.
// =============================================================
export async function invalidateOwnerSessions(db, homestayId) {
  if (!homestayId) return;
  return await incrementOwnerSessionVersion(db, homestayId);
}

// =============================================================
// D1-Compatible Lock using INSERT OR IGNORE (no transactions)
// =============================================================
export async function withLock(db, lockKey, callback, staleTimeoutMs = 5000) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS homestay_locks (
      homestay_id TEXT PRIMARY KEY,
      locked_at INTEGER
    )`
  ).run();

  const now = Date.now();

  // 1. Try to insert the lock
  let insertResult = await db.prepare(
    `INSERT OR IGNORE INTO homestay_locks (homestay_id, locked_at) VALUES (?, ?)`
  ).bind(lockKey, now).run();

  // 2. If insertion failed, lock exists – check staleness
  if (insertResult.meta.changes === 0) {
    const existing = await db.prepare(
      `SELECT locked_at FROM homestay_locks WHERE homestay_id = ?`
    ).bind(lockKey).first();

    if (existing && (now - existing.locked_at) > staleTimeoutMs) {
      // Stale lock – take over
      await db.prepare(`DELETE FROM homestay_locks WHERE homestay_id = ?`).bind(lockKey).run();
      insertResult = await db.prepare(
        `INSERT OR IGNORE INTO homestay_locks (homestay_id, locked_at) VALUES (?, ?)`
      ).bind(lockKey, now).run();
      if (insertResult.meta.changes === 0) {
        throw new Error('Another operation is in progress. Please try again in a moment.');
      }
    } else {
      throw new Error('Another operation is in progress. Please try again in a moment.');
    }
  }

  // 3. Lock acquired – execute callback
  try {
    return await callback(db);
  } finally {
    // 4. Always release
    await db.prepare(`DELETE FROM homestay_locks WHERE homestay_id = ?`).bind(lockKey).run();
  }
}

// =============================================================
// Payment finalization (idempotent, lock-protected by caller)
// =============================================================
export async function finalizePaidBooking(db, bookingId) {
  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
  const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
  if (idx === -1) return { error: 'Booking not found' };

  const booking = bookings[idx];

  // Another confirmation path already finalized this booking.
  const s = String(booking.status || '');
  if (s === 'Paid - Awaiting Check-in' || s === 'Completed' || s.startsWith('Completed')) {
    return {
      alreadyFinalized: true,
      booking,
      checkinCode: booking.checkinCode
    };
  }

  const codeWasMissing = !booking.checkinCode;
  const code = booking.checkinCode || Math.floor(100000 + Math.random() * 900000).toString();

  const updated = {
    ...booking,
    status: 'Paid - Awaiting Check-in',
    checkinCode: code,
    paid_at: booking.paid_at || new Date().toISOString(),
    chip_status: 'paid',
    chip_paid_at: booking.chip_paid_at || new Date().toISOString()
  };

  bookings[idx] = updated;

  await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
    .bind('kd_bookings', JSON.stringify(bookings))
    .run();

  return {
    finalized: true,
    codeWasMissing,
    checkinCode: code,
    booking: updated
  };
}
