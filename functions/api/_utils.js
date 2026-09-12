// SHARED HELPERS — full drop-in replacement.
//
// [THIS REVISION]
//  (1) finalizePaidBooking stores `amount_paid`.
//  (2) finalizePaidBooking refuses to finalize if the guest account no
//      longer exists.
//  (3) chipSendPayout validates the bank code against CHIP Send's known
//      SWIFT/BIC list and refuses before calling CHIP.
//  (4) getOwnerHomestayIdsFresh(db, owner) resolves an owner's homestay
//      IDs by matching WhatsApp in kd_approved / kd_pending.
//  (5) sendHostPayoutEmail(booking, homestay, payoutInfo, env) sends a
//      payout receipt to the host after a successful CHIP Send transfer.
//      [NEW] When payoutInfo.isSimulation is true, the subject line gets
//      a [TEST] prefix and a bright banner is drawn at the top of the
//      email body. This lets the admin verify the email in sandbox
//      without any risk of a host mistaking a simulated receipt for a
//      real one.

export const MAX_BODY_SIZE = 1024 * 1024; // 1MB

const DEFAULT_PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH = 'SHA-256';
const PBKDF2_KEYLEN = 256;

const VALID_CHIP_SEND_CODES = new Set([
  'ACDBMYK2','PHBMMYKL','AGOBMYKL','RJHIMYKL','MFBBMYKL','ARBKMYKL',
  'BIMBMYKL','BKRMMYKL','BMMBMYKL','BOFAMY2X','BKCHMYKL','BOTKMYKX',
  'BSNAMYK1','BNPAMYKL','PCBCMYKL','CIBBMYKL','DEUTMYKL','FNXSMYNB',
  'GXSPMYKL','HLBBMYKL','HBMBMYKL','ICBKMYKL','CHASMYKX','KFHOMYKL',
  'MBBEMYKL','AFBQMYKL','MHCBMYKA','OCBCMYKL','PBBEMYKL','RHBBMYKL',
  'SCBLMYKX','SMBCMYKL','TNGDMYNB','UOVBMYKL'
]);

function getPbkdf2Iterations(env) {
  const fromEnv = env && env.PBKDF2_ITERATIONS;
  const parsed = parseInt(fromEnv, 10);
  if (Number.isFinite(parsed) && parsed >= 10000 && parsed <= 2000000) {
    return parsed;
  }
  return DEFAULT_PBKDF2_ITERATIONS;
}

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

export async function createSignedToken(payload, env, ttlMs = 24 * 60 * 60 * 1000) {
  const secret = requireSessionSecret(env);
  const body = { ...payload, iat: Date.now(), exp: Date.now() + ttlMs };
  const encoded = b64urlEncode(JSON.stringify(body));
  const signature = await hmacSign(encoded, secret);
  return `${encoded}.${signature}`;
}

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

async function getUserRecord(type, userId, db) {
  if (type === 'guest') {
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch(_) {}
    return guests.find(g => String(g.id) === String(userId)) || null;
  } else if (type === 'owner') {
    const key = String(userId || '');
    const cleanWa = key.replace(/[^0-9]/g, '');

    const ownersRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
    let owners = [];
    try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch(_) {}
    const ownerAccount = owners.find(o =>
      String(o.id) === key ||
      (cleanWa && String(o.whatsapp || '').replace(/[^0-9]/g, '') === cleanWa)
    );
    if (ownerAccount) return ownerAccount;

    const approved = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
    const pending = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
    let homes = [];
    try { if (approved?.data) homes = homes.concat(JSON.parse(approved.data)); } catch(_) {}
    try { if (pending?.data) homes = homes.concat(JSON.parse(pending.data)); } catch(_) {}
    return homes.find(h =>
      String(h.id) === key ||
      (cleanWa && String(h.whatsapp || '').replace(/[^0-9]/g, '') === cleanWa)
    ) || null;
  }
  return null;
}

async function getOwnerMaxSessionVersion(db, ownerIdOrWhatsapp) {
  const key = String(ownerIdOrWhatsapp || '').trim();
  const cleanWa = key.replace(/[^0-9]/g, '');
  let maxVersion = 0;
  let found = false;

  const ownersRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
  let owners = [];
  try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch(_) {}
  for (const o of owners) {
    const matches = String(o.id) === key ||
      (cleanWa && String(o.whatsapp || '').replace(/[^0-9]/g, '') === cleanWa);
    if (matches) {
      found = true;
      const v = Number(o.ownerSessionVersion || 0);
      if (v > maxVersion) maxVersion = v;
    }
  }

  const approved = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
  const pending = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
  let homes = [];
  try { if (approved?.data) homes = homes.concat(JSON.parse(approved.data)); } catch(_) {}
  try { if (pending?.data) homes = homes.concat(JSON.parse(pending.data)); } catch(_) {}
  for (const h of homes) {
    const matches = String(h.id) === key ||
      (cleanWa && String(h.whatsapp || '').replace(/[^0-9]/g, '') === cleanWa);
    if (matches) {
      found = true;
      const v = Number(h.ownerSessionVersion || 0);
      if (v > maxVersion) maxVersion = v;
    }
  }

  return { found, maxVersion };
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

  if (payload.ownerSessionVersion !== undefined) {
    const { found, maxVersion } = await getOwnerMaxSessionVersion(db, payload.ownerId);
    if (found && maxVersion !== Number(payload.ownerSessionVersion)) return null;
  }
  return payload;
}

export async function getOwnerHomestayIdsFresh(db, ownerOrWhatsapp) {
  if (!db) return [];
  const rawWa = (typeof ownerOrWhatsapp === 'string')
    ? ownerOrWhatsapp
    : (ownerOrWhatsapp?.whatsapp || ownerOrWhatsapp?.ownerId || '');
  const cleanWa = String(rawWa || '').replace(/[^0-9]/g, '');
  if (!cleanWa) return [];

  const ids = new Set();
  for (const key of ['kd_approved', 'kd_pending']) {
    try {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();
      if (!r?.data) continue;
      const arr = JSON.parse(r.data);
      arr.forEach(h => {
        const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
        if (hWa && hWa === cleanWa) ids.add(String(h.id));
      });
    } catch (_) {}
  }
  return [...ids];
}

export function cleanWhatsapp(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

export function getBearerToken(request, headerName = 'Authorization') {
  const auth = request.headers.get(headerName) || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim();
}

export function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export function cookieHeader(name, value, maxAge = 86400, sameSite = 'Lax') {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}; Path=/`;
}

export function clearCookieHeader(name, sameSite = 'Lax') {
  return `${name}=; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=0; Path=/`;
}

export function generateSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return b64urlEncode(bytes);
}

async function derivePassword(password, salt, pepper, iterations) {
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
  const iterations = getPbkdf2Iterations(env);
  const algorithm = `PBKDF2-${iterations}-SHA256`;
  return {
    hash: await derivePassword(password, salt, pepper, iterations),
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
    const iterations = parts.length >= 2 ? parseInt(parts[1], 10) : DEFAULT_PBKDF2_ITERATIONS;
    if (isNaN(iterations) || iterations <= 0) {
      const computed = await derivePassword(password, salt, pepper, DEFAULT_PBKDF2_ITERATIONS);
      return { ok: computed === hash, legacy: false };
    }
    const computed = await derivePassword(password, salt, pepper, iterations);
    return { ok: computed === hash, legacy: false };
  }

  const legacyPepper = env?.LEGACY_PASSWORD_PEPPER || env?.PASSWORD_PEPPER || 'kundasang-homestay-2026';
  const computedLegacy = await sha256(legacyPepper + password + salt);
  return { ok: computedLegacy === hash, legacy: true };
}

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
      "img-src 'self' data: blob: https://upload.wikimedia.org https://i.ibb.co https://www.clladventureborneo.com https://blogger.googleusercontent.com https://lh3.googleusercontent.com https://explorekundasang.com https://res.cloudinary.com https://theculturetrip.com https://*.theculturetrip.com",
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

export function enforceHttps(request) {
  const url = new URL(request.url);
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return new Response(null, { status: 301, headers: { Location: url.toString() } });
  }
  return null;
}

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

export async function getAdminToken(request, env) {
  const cookie = getCookie(request, 'admin_token');
  if (cookie) return cookie;
  if (env?.ALLOW_ADMIN_BEARER === 'true') {
    return getBearerToken(request);
  }
  return null;
}

export async function getAdminSession(request, env) {
  let token = getCookie(request, 'admin_token');
  if (!token && env?.ALLOW_ADMIN_BEARER === 'true') {
    token = getBearerToken(request);
  }
  if (!token) return null;
  try {
    const payload = await verifySignedToken(token, env);
    if (!payload || payload.type !== 'admin') return null;
    return payload;
  } catch (_) {
    return null;
  }
}

export async function verifyAdminAuth(request, env) {
  const session = await getAdminSession(request, env);
  return !!session;
}

export function jsonResponse(body, status, request, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), ...extra }
  });
}

export function errorResponse(message, status, request, logDetails = null) {
  return jsonResponse({ error: message || 'An unexpected error occurred. Please try again later.' }, status, request);
}

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

export async function incrementOwnerSessionVersion(db, ownerIdOrWhatsapp) {
  const input = String(ownerIdOrWhatsapp || '').trim();
  if (!input) return false;

  let whatsapp = null;

  const ownersRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
  let owners = [];
  try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch (_) {}
  const ownerAccount = owners.find(o => String(o.id) === input);
  if (ownerAccount && ownerAccount.whatsapp) {
    whatsapp = String(ownerAccount.whatsapp).replace(/[^0-9]/g, '');
  }

  if (!whatsapp) {
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
  }
  if (!whatsapp) whatsapp = input.replace(/[^0-9]/g, '');
  if (!whatsapp) return false;

  let changed = false;

  let ownersChanged = false;
  owners = owners.map(o => {
    const oWa = String(o.whatsapp || '').replace(/[^0-9]/g, '');
    if (oWa === whatsapp) {
      ownersChanged = true;
      changed = true;
      o.ownerSessionVersion = (o.ownerSessionVersion || 0) + 1;
    }
    return o;
  });
  if (ownersChanged) {
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_owners', JSON.stringify(owners)).run();
  }

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

export async function invalidateOwnerSessionsForHomestay(db, homestayId) {
  if (!homestayId) return false;
  return await incrementOwnerSessionVersion(db, homestayId);
}

export async function invalidateOwnerSessionsForOwner(db, ownerIdOrWhatsapp) {
  if (!ownerIdOrWhatsapp) return false;
  return await incrementOwnerSessionVersion(db, ownerIdOrWhatsapp);
}

export async function invalidateOwnerSessions(db, homestayId) {
  return invalidateOwnerSessionsForHomestay(db, homestayId);
}

export async function withLock(db, lockKey, callback, staleTimeoutMs = 5000) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS homestay_locks (
      homestay_id TEXT PRIMARY KEY,
      locked_at INTEGER
    )`
  ).run();

  const myLockValue = Date.now();

  let insertResult = await db.prepare(
    `INSERT OR IGNORE INTO homestay_locks (homestay_id, locked_at) VALUES (?, ?)`
  ).bind(lockKey, myLockValue).run();

  if (insertResult.meta.changes === 0) {
    const existing = await db.prepare(
      `SELECT locked_at FROM homestay_locks WHERE homestay_id = ?`
    ).bind(lockKey).first();

    if (existing && (myLockValue - existing.locked_at) > staleTimeoutMs) {
      const casResult = await db.prepare(
        `UPDATE homestay_locks SET locked_at = ? WHERE homestay_id = ? AND locked_at = ?`
      ).bind(myLockValue, lockKey, existing.locked_at).run();
      if (!casResult.meta || casResult.meta.changes === 0) {
        throw new Error('Another operation is in progress. Please try again in a moment.');
      }
    } else {
      throw new Error('Another operation is in progress. Please try again in a moment.');
    }
  }

  try {
    return await callback(db);
  } finally {
    try {
      await db.prepare(
        `DELETE FROM homestay_locks WHERE homestay_id = ? AND locked_at = ?`
      ).bind(lockKey, myLockValue).run();
    } catch (_) {
      // Best-effort release.
    }
  }
}

export async function finalizePaidBooking(db, bookingId) {
  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
  const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
  if (idx === -1) return { error: 'Booking not found' };

  const booking = bookings[idx];

  if (booking.guestId) {
    const gr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
    let guests = [];
    try { if (gr?.data) guests = JSON.parse(gr.data); } catch(_) {}
    const guestExists = guests.some(g => String(g.id) === String(booking.guestId));
    if (!guestExists) {
      return { error: 'Guest account has been deleted. Refund required before finalization.' };
    }
  }

  const s = String(booking.status || '');
  if (s === 'Paid - Awaiting Check-in' || s === 'Completed' || s.startsWith('Completed')) {
    return {
      alreadyFinalized: true,
      booking,
      checkinCode: booking.checkinCode
    };
  }

  if (/cancelled|refunded|expired/i.test(s)) {
    return {
      refuseFinalize: true,
      reason: `Booking was ${s} before payment settled. CHIP refund required.`,
      booking
    };
  }

  const codeWasMissing = !booking.checkinCode;
  const code = booking.checkinCode || (() => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return String(100000 + (buf[0] % 900000));
  })();

  const updated = {
    ...booking,
    status: 'Paid - Awaiting Check-in',
    checkinCode: code,
    paid_at: booking.paid_at || new Date().toISOString(),
    chip_status: 'paid',
    chip_paid_at: booking.chip_paid_at || new Date().toISOString(),
    amount_paid: booking.amount_paid || Number(booking.total) || 0
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

// ============================================================
// Host payout receipt email.
// Sent after a successful CHIP Send payout to the host.
//
// Arguments:
//   booking    — the booking object
//   homestay   — the homestay object (name, ownerName, ownerEmail,
//                ownerBank, ownerBankAccount)
//   payoutInfo — { amount, payoutId, reference, paidAt, isSimulation }
//                When isSimulation is true, the subject gets a [TEST]
//                prefix and a bright banner is drawn at the top of the
//                email body. This lets the admin verify delivery in
//                sandbox without any risk of a host mistaking the
//                receipt for a real one.
//   env        — Cloudflare env
//
// Best-effort — a failure never rolls back the payout.
// ============================================================
export async function sendHostPayoutEmail(booking, homestay, payoutInfo, env) {
  if (!homestay || !homestay.ownerEmail) {
    return { sent: false, error: 'No host email on file' };
  }
  const safe = (s) => String(s || '').replace(/[<>]/g, '');
  const isSimulation = !!payoutInfo.isSimulation;

  const ownerName = safe(homestay.ownerName || 'Host');
  const homestayName = safe(homestay.name || 'your property');
  const payoutAmount = Number(payoutInfo.amount || 0).toFixed(2);
  const total = Number(booking.total || 0).toFixed(2);
  const fee = Number(booking.fee || 0).toFixed(2);
  const gatewayFee = Number(booking.gatewayFee || 0).toFixed(2);
  const ref = safe(payoutInfo.reference || `KDH-${booking.id}`);
  const payoutId = safe(payoutInfo.payoutId || 'N/A');
  const paidAtIso = payoutInfo.paidAt || new Date().toISOString();
  const paidAt = (() => {
    try {
      return new Date(paidAtIso).toLocaleString('en-MY', {
        timeZone: 'Asia/Kuala_Lumpur',
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true
      }) + ' MYT';
    } catch (_) { return paidAtIso; }
  })();

  const acct = String(homestay.ownerBankAccount || '').replace(/[^0-9]/g, '');
  const bankMasked = acct.length >= 4 ? '****' + acct.slice(-4) : 'N/A';
  const bankName = safe(homestay.ownerBank || 'Bank');

  const testBanner = isSimulation ? `
    <div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:12px;padding:16px;margin-bottom:20px;text-align:center;">
      <div style="font-size:13px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:1.5px;">⚠️ Test Email — Simulated Payout</div>
      <div style="font-size:12px;color:#78350f;margin-top:6px;line-height:1.5;">
        This receipt was generated in <strong>simulation mode</strong>.<br>
        No real money was transferred to any bank account.
      </div>
    </div>
  ` : '';

  const headerSubtitle = isSimulation ? 'Payout Receipt — TEST' : 'Payout Receipt';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;background:#f8f5f0;padding:20px;">
      <div style="background:#ffffff;padding:30px;border-radius:16px;border:1px solid #e5e7eb;">

        ${testBanner}

        <div style="text-align:center;border-bottom:2px solid #0F382E;padding-bottom:16px;margin-bottom:22px;">
          <div style="font-size:22px;font-weight:800;color:#0F382E;">Kundasang Homestay</div>
          <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;margin-top:4px;">${headerSubtitle}</div>
        </div>

        <h2 style="color:#0F382E;margin-top:0;font-size:18px;">Hello ${ownerName},</h2>
        <p style="color:#4b5563;font-size:14px;line-height:1.6;">
          A payout for a completed guest stay at <strong>${homestayName}</strong> has been ${isSimulation ? 'simulated (test)' : 'sent to your bank account via CHIP Send'}.
        </p>

        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:22px 0;text-align:center;">
          <div style="font-size:11px;color:#166534;text-transform:uppercase;letter-spacing:1px;font-weight:700;">${isSimulation ? 'Amount (simulated)' : 'Amount Received'}</div>
          <div style="font-size:32px;font-weight:800;color:#0F382E;margin:6px 0;">RM ${payoutAmount}</div>
          <div style="font-size:12px;color:#166534;">${isSimulation ? 'Simulated payout — no funds moved' : `Sent to ${bankName} ${bankMasked}`}</div>
        </div>

        <div style="font-size:13px;color:#4b5563;margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Payout Details</div>
        <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:20px;color:#374151;">
          <tr>
            <td style="padding:7px 0;color:#6b7280;">Reference</td>
            <td style="padding:7px 0;text-align:right;font-family:'Courier New',monospace;font-weight:700;">${ref}</td>
          </tr>
          <tr>
            <td style="padding:7px 0;color:#6b7280;">${isSimulation ? 'Simulation ID' : 'CHIP Send ID'}</td>
            <td style="padding:7px 0;text-align:right;font-family:'Courier New',monospace;">${payoutId}</td>
          </tr>
          <tr>
            <td style="padding:7px 0;color:#6b7280;">Date</td>
            <td style="padding:7px 0;text-align:right;">${paidAt}</td>
          </tr>
        </table>

        <div style="font-size:13px;color:#4b5563;margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Booking Details</div>
        <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:20px;color:#374151;">
          <tr>
            <td style="padding:7px 0;color:#6b7280;">Booking ID</td>
            <td style="padding:7px 0;text-align:right;font-family:'Courier New',monospace;">${safe(booking.id)}</td>
          </tr>
          <tr>
            <td style="padding:7px 0;color:#6b7280;">Guest</td>
            <td style="padding:7px 0;text-align:right;">${safe(booking.guestName || 'Guest')}</td>
          </tr>
          <tr>
            <td style="padding:7px 0;color:#6b7280;">Check-in</td>
            <td style="padding:7px 0;text-align:right;">${safe(booking.checkin)}</td>
          </tr>
          <tr>
            <td style="padding:7px 0;color:#6b7280;">Check-out</td>
            <td style="padding:7px 0;text-align:right;">${safe(booking.checkout)} (${safe(booking.nights)} night${Number(booking.nights) === 1 ? '' : 's'})</td>
          </tr>
        </table>

        <div style="font-size:13px;color:#4b5563;margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Payment Breakdown</div>
        <table style="width:100%;font-size:13px;border-collapse:collapse;color:#374151;">
          <tr>
            <td style="padding:7px 0;color:#6b7280;">Guest paid</td>
            <td style="padding:7px 0;text-align:right;">RM ${total}</td>
          </tr>
          <tr>
            <td style="padding:7px 0;color:#6b7280;">Service fee (11%)</td>
            <td style="padding:7px 0;text-align:right;color:#b91c1c;">− RM ${fee}</td>
          </tr>
          <tr>
            <td style="padding:7px 0;color:#6b7280;">Gateway fee</td>
            <td style="padding:7px 0;text-align:right;color:#b91c1c;">− RM ${gatewayFee}</td>
          </tr>
          <tr style="border-top:2px solid #0F382E;">
            <td style="padding:10px 0;font-weight:700;color:#0F382E;">${isSimulation ? 'Simulated payout' : 'You received'}</td>
            <td style="padding:10px 0;text-align:right;font-weight:800;color:#0F382E;font-size:15px;">RM ${payoutAmount}</td>
          </tr>
        </table>

        <p style="font-size:12px;color:#6b7280;margin-top:22px;line-height:1.6;border-top:1px solid #e5e7eb;padding-top:16px;">
          ${isSimulation
            ? 'This is a test email sent from a sandbox environment. No action is needed.'
            : 'Keep this email for your book-keeping. If you have any questions about this payout, reply to this email or contact us at <a href="mailto:support@kundasanghomestay.my" style="color:#0F382E;">support@kundasanghomestay.my</a>.'}
        </p>

        <p style="font-size:12px;color:#9ca3af;text-align:center;margin-bottom:0;">
          © ${new Date().getFullYear()} Kundasang Homestay
        </p>

      </div>
    </div>
  `;

  const subject = isSimulation
    ? `[TEST] Payout Receipt — RM ${payoutAmount} for Booking ${booking.id}`
    : `Payout Receipt — RM ${payoutAmount} for Booking ${booking.id}`;

  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: homestay.ownerEmail,
          subject,
          html
        })
      });
      return { sent: r.ok, error: r.ok ? null : 'Resend API error' };
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: homestay.ownerEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject,
          content: [{ type: 'text/html', value: html }]
        })
      });
      return { sent: r.ok, error: r.ok ? null : 'SendGrid API error' };
    }
    return { sent: false, error: 'No email provider configured' };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

// ============================================================
// CHIP SEND — 4-STEP FLOW
// ============================================================

async function chipHmacSha512(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function chipSendPayout({
  db,
  homestayId,
  homestay,
  amount,
  reference,
  description,
  env,
  logAction: logFn
}) {
  const apiKey = env.CHIP_API_KEY;
  const apiSecret = env.CHIP_API_SECRET;
  const isLive = !!(apiKey && apiSecret);

  if (!isLive) {
    return { success: false, error: 'CHIP Send credentials missing' };
  }

  const baseUrl = 'https://api.chip-in.asia/api/send';
  const headers = (epoch) => ({
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'epoch': String(epoch),
    'checksum': ''
  });

  const accountName = homestay.bankHolder || homestay.ownerName || '';
  const accountNumber = (homestay.ownerBankAccount || '').replace(/[^0-9]/g, '');
  const bankCode = (homestay.bankCode || '').toUpperCase().trim();

  if (!accountNumber || accountNumber.length < 8) {
    return { success: false, error: 'Owner bank account invalid or missing (must be at least 8 digits)' };
  }
  if (!accountName) {
    return { success: false, error: 'Owner bank holder name missing' };
  }
  if (!bankCode) {
    return {
      success: false,
      error: 'Owner bank code is missing. This listing cannot be paid out. Admin must set the bank code via the admin dashboard before retrying.'
    };
  }
  if (!VALID_CHIP_SEND_CODES.has(bankCode)) {
    return {
      success: false,
      error: `Owner bank code "${bankCode}" is not a recognised CHIP Send bank code. Admin must correct this in the admin dashboard before retrying.`
    };
  }

  const amountCents = Math.round(amount * 100);
  if (amountCents <= 0) {
    return { success: false, error: 'Invalid payout amount' };
  }

  try {
    const epoch1 = Math.floor(Date.now() / 1000);
    const checksum1 = await chipHmacSha512(`${epoch1}${apiKey}`, apiSecret);
    const balanceRes = await fetch(`${baseUrl}/accounts`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'epoch': String(epoch1),
        'checksum': checksum1
      }
    });

    if (!balanceRes.ok) {
      const txt = await balanceRes.text().catch(() => '');
      return { success: false, error: `CHIP Send balance check failed (HTTP ${balanceRes.status}): ${txt.slice(0, 200)}` };
    }

    const balanceData = await balanceRes.json();
    const convertible = Number(balanceData?.convertible_balance_from_statement || 0);
    const available = Number(balanceData?.available_balance || 0);

    if (convertible < amountCents && available < amountCents) {
      return {
        success: false,
        error: `Insufficient CHIP Send balance. Convertible: ${(convertible / 100).toFixed(2)}, Available: ${(available / 100).toFixed(2)}, Needed: ${(amountCents / 100).toFixed(2)}. Please top up your CHIP Send balance or wait for the next Collect settlement.`
      };
    }
  } catch (e) {
    return { success: false, error: `CHIP Send balance check network error: ${e.message}` };
  }

  try {
    const epoch2 = Math.floor(Date.now() / 1000);
    const checksum2 = await chipHmacSha512(`${epoch2}${apiKey}`, apiSecret);
    const limitRes = await fetch(`${baseUrl}/send_limits`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'epoch': String(epoch2),
        'checksum': checksum2
      },
      body: JSON.stringify({ amount: amountCents })
    });

    if (!limitRes.ok) {
      const txt = await limitRes.text().catch(() => '');
      if (txt.includes('no conversion') || txt.includes('already sufficient')) {
        // fall through
      } else {
        return { success: false, error: `CHIP Send budget allocation failed (HTTP ${limitRes.status}): ${txt.slice(0, 200)}` };
      }
    } else {
      const limitData = await limitRes.json();
      if (limitData?.status && String(limitData.status).toLowerCase().includes('pending')) {
        return {
          success: false,
          error: `CHIP Send budget allocation is pending approval. An approver must confirm in the CHIP portal before this payout can proceed. Amount: RM${(amountCents / 100).toFixed(2)}.`
        };
      }
    }
  } catch (e) {
    return { success: false, error: `CHIP Send budget allocation network error: ${e.message}` };
  }

  let bankAccountId = homestay.chip_bank_account_id || null;

  if (!bankAccountId) {
    try {
      const epoch3 = Math.floor(Date.now() / 1000);
      const checksum3 = await chipHmacSha512(`${epoch3}${apiKey}`, apiSecret);
      const bankRes = await fetch(`${baseUrl}/bank_accounts`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'epoch': String(epoch3),
          'checksum': checksum3
        },
        body: JSON.stringify({
          bank_code: bankCode,
          account_number: accountNumber,
          account_name: accountName
        })
      });

      if (!bankRes.ok) {
        const txt = await bankRes.text().catch(() => '');
        return { success: false, error: `CHIP Send bank account registration failed (HTTP ${bankRes.status}): ${txt.slice(0, 200)}` };
      }

      const bankData = await bankRes.json();
      if (!bankData?.id) {
        return { success: false, error: 'CHIP Send bank account registration returned no ID' };
      }
      bankAccountId = bankData.id;

      if (homestayId && db) {
        for (const store of ['kd_approved', 'kd_homestays', 'kd_pending']) {
          const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(store).first();
          let list = [];
          try { if (r?.data) list = JSON.parse(r.data); } catch (_) {}
          if (!Array.isArray(list) || list.length === 0) continue;
          const idx = list.findIndex(h => String(h.id) === String(homestayId));
          if (idx === -1) continue;
          list[idx].chip_bank_account_id = bankAccountId;
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind(store, JSON.stringify(list))
            .run();
        }
      }
    } catch (e) {
      return { success: false, error: `CHIP Send bank account registration network error: ${e.message}` };
    }
  }

  try {
    const epoch4 = Math.floor(Date.now() / 1000);
    const checksum4 = await chipHmacSha512(`${epoch4}${apiKey}`, apiSecret);
    const sendRes = await fetch(`${baseUrl}/send_instructions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'epoch': String(epoch4),
        'checksum': checksum4
      },
      body: JSON.stringify({
        bank_account_id: bankAccountId,
        amount: amountCents,
        reference: reference,
        description: description,
        email: homestay.ownerEmail || '',
        send_recipient_receipt: true
      })
    });

    let sendData = null;
    let parseFailed = false;
    try { sendData = await sendRes.json(); } catch (_) { parseFailed = true; }

    if (parseFailed) {
      return {
        success: false,
        unknown: true,
        error: `CHIP Send returned an unparseable response. Payout status is UNKNOWN — verify reference ${reference} in the CHIP dashboard before retrying.`
      };
    }

    if (!sendRes.ok || !sendData?.id) {
      const errStr = String(sendData?.error || sendData?.message || '').toLowerCase();
      const isStructuredRejection = sendRes.status >= 400 && sendRes.status < 500 && errStr.length > 0;

      if (isStructuredRejection) {
        return {
          success: false,
          error: `CHIP Send rejected the payout: ${sendData.error || sendData.message}`
        };
      }

      return {
        success: false,
        unknown: true,
        error: `CHIP Send response ambiguous (HTTP ${sendRes.status}). Payout status is UNKNOWN — verify reference ${reference} in the CHIP dashboard before retrying.`
      };
    }

    return {
      success: true,
      payoutId: sendData.id,
      amount: amountCents,
      raw: sendData
    };
  } catch (e) {
    return {
      success: false,
      unknown: true,
      error: `CHIP Send network error during payout: ${e.message}. Reference ${reference} may have been sent — verify in CHIP dashboard before retrying.`
    };
  }
}
