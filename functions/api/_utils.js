// SHARED HELPERS — full drop-in replacement.
//
// [THIS REVISION — September 2026 — Phase 1 of the security hardening pass]
//
// WHAT CHANGED IN THIS FILE (summary):
//   1. PASSWORD_PEPPER is now REQUIRED. No more fallback to SESSION_SECRET.
//      No more hardcoded 'kundasang-homestay-2026'. This prevents the
//      "rotate SESSION_SECRET, everyone locked out forever" footgun and
//      closes the hardcoded-pepper hole.
//   2. verifyPassword uses constant-time comparison (was `===`).
//   3. getGuestSession / getOwnerSession session-version checks now FAIL
//      CLOSED when either side is missing, instead of silently skipping.
//   4. getClientIP only trusts CF-Connecting-IP (was falling back to
//      client-controllable X-Forwarded-For).
//   5. checkRateLimit defaults to FAIL CLOSED on DB error. Pass
//      { failOpen: true } if a caller really wants the old behavior.
//   6. withLock default stale timeout raised 5s → 30s. Webhook/lock
//      operations that call CHIP can take longer than 5s, and a 5s
//      timeout lets a second process steal the lock mid-flight.
//   7. enforceHttps returns 308 (was 301). 301 on a POST can strip the
//      method and body.
//   8. finalizePaidBooking now sets two new fields on the booking:
//      checkin_email_status ('pending') and receiptNo (stable per booking).
//   9. NEW canonical helpers shared across the money path so we can stop
//      copy-pasting them into 3-4 files:
//        escHtml / escAttr       — proper HTML escaping
//        safeUrl                 — only http(s) URLs into href/src
//        sendEmail               — one provider-selection function
//        sendCheckinEmail        — the canonical guest email
//        sendRefundEmail         — the canonical refund email
//        tryAutoRefundLatePaymentLocked — was duplicated in 3 files
//        finalizeAndNotify       — the whole lock + finalize + refund +
//                                  email + log flow in one function
//  10. sendHostPayoutEmail / sendPayoutRecordEmail now delegate to
//      sendEmail internally (no behavior change, just less duplication).
//  11. ensureRateLimitTable caches per-process so we're not doing DDL on
//      every API call.
//
// WHAT THIS FILE DOES *NOT* FIX (do in later phases):
//   - CSP header on JSON responses (pointless, wasted bytes — Phase 6)
//   - 'unsafe-inline' in script-src (needs inline scripts moved to files)
//   - Whole-table reads of kd_* blobs (needs DB migration — Phase 4)
//   - `GET /api/bookings` public branch loading kd_guests (bookings.js)
//   - `getAdminToken`, `invalidateOwnerSessions`, `invalidateOwnerSessionsForOwner`
//     are still exported (unused aliases — will remove in Phase 2/3 cleanup)
//
// ALL EXISTING EXPORTS KEEP THE SAME NAME AND SIGNATURE. This is a drop-in
// replacement. Only *behavior* has changed (see list above).
//
// ============================================================
// BEFORE YOU DEPLOY THIS FILE, VERIFY YOUR CLOUDFLARE ENV VARS:
//
//   PASSWORD_PEPPER         MUST be set. 32+ random characters.
//                           Different from SESSION_SECRET.
//                           If unset, hashPassword will throw.
//   SESSION_SECRET          Already set (you have it).
//   LEGACY_PASSWORD_PEPPER  Only needed if you had legacy SHA-256 hashes
//                           from before PBKDF2. You have 0 users, so you
//                           don't. Do NOT set it. If it's ever unset and
//                           a legacy hash is encountered, verification
//                           will fail closed (return false) instead of
//                           falling back to a hardcoded secret.
//
// If you deploy this without PASSWORD_PEPPER set, new registrations will
// fail with "PASSWORD_PEPPER is required". That's intentional.
// ============================================================

export const MAX_BODY_SIZE = 1024 * 1024; // 1MB

// ============================================================
// CANCELLATION TIERS — the one true copy of the refund maths
//
//   Tier A: guest asked 14+ days before check-in
//   Tier B: guest asked 2 to 13 days before check-in
//   Tier C: guest asked less than 2 days before, or after check-in
//
// Counting is by whole calendar days only — no clock times involved.
// Days-before = (arrival date) minus (date the guest asked), in MYT
// (UTC+8). The hour the guest asked does not matter; only the day.
// Example: arrival 29 Sept, asked any time on 15 Sept => 14 days => A.
// Asked on 16 Sept => 13 days => B. Asked on 27 Sept => 2 days => B.
// Asked on 28 or 29 Sept => < 2 => C.
//
// Tier A: guest gets everything they paid, less the RM 1.00 refund
//         fee. Host gets nothing.
// Tier B: guest gets half the room price, rounded DOWN to the sen.
//         Host gets the other half — so the two add up exactly.
// Tier C: guest gets nothing. Host gets the full room price.
//
// Every caller must use this. Do not work out a refund anywhere else.
// ============================================================

const TIER_REFUND_FEE = 1.00;

function tierRound2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function computeCancellationTier(booking, requestedAtMs) {
  const base = tierRound2(booking?.base);
  const totalPaid = tierRound2(Number(booking?.amount_paid) || Number(booking?.total) || 0);

  // Whole-calendar-day counting in MYT (UTC+8), no clock times.
  // MYT has no daylight saving, so a fixed +08:00 offset is exact.
  const toMytDay = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);

  const checkin = String(booking?.checkin || '');
  const askedMs = Number(requestedAtMs);

  const refDay = /^\d{4}-\d{2}-\d{2}$/.test(checkin) ? checkin : '';
  const askedDay = Number.isFinite(askedMs) ? toMytDay(askedMs) : '';

  if (!refDay || !askedDay) {
    return {
      tier: null,
      needsReview: true,
      base,
      totalPaid,
      guestAmount: 0,
      hostAmount: 0,
      platformKeeps: 0,
      chipRefundFee: TIER_REFUND_FEE,
      note: 'Could not determine the check-in date or the request date. Needs manual review.'
    };
  }

  const DAY = 86400000;
  const leadDays = Math.round((Date.parse(refDay + 'T00:00:00Z') -
                               Date.parse(askedDay + 'T00:00:00Z')) / DAY);
  const leadMs = leadDays * DAY;

  let tier;
  if (leadDays >= 14) tier = 'A';
  else if (leadDays >= 2) tier = 'B';
  else tier = 'C';

  if (tier !== 'A' && !(base > 0)) {
    return {
      tier: null,
      needsReview: true,
      base,
      totalPaid,
      guestAmount: 0,
      hostAmount: 0,
      platformKeeps: 0,
      chipRefundFee: TIER_REFUND_FEE,
      note: 'This booking has no room price recorded, so a tier refund cannot be worked out automatically. Needs manual review.'
    };
  }

  const guestAmount =
    tier === 'A' ? tierRound2(Math.max(0, totalPaid - TIER_REFUND_FEE)) :
    tier === 'B' ? Math.floor(base * 50) / 100 :
    0;

  const hostAmount =
    tier === 'A' ? 0 :
    tier === 'B' ? tierRound2(base - guestAmount) :
    base;

  return {
    tier,
    needsReview: false,
    leadMs,
    leadDays: Math.floor(leadMs / DAY),
    base,
    totalPaid,
    guestAmount,
    hostAmount,
        platformKeeps: tierRound2(totalPaid - guestAmount - hostAmount),
    chipRefundFee: TIER_REFUND_FEE
  };
}

// ============================================================
// NON-TIER CANCELLATION OUTCOMES
//
// Three published policy outcomes are NOT tier cases, because none of
// them is caused by the guest giving a certain amount of notice. A tier
// measures how much notice the GUEST gave; these have no notice period
// to measure, so cancellation_tier is always null for them.
//
//   no_show           ⚪ guest never arrived, no contact within 24h
//                        guest 0, host the full room price
//   emergency_no_show 🟣 guest never arrived but proved a real emergency
//                        guest half the room price, host the other half
//   platform          🔵 we cancelled (force majeure, travel ban, etc.)
//                        guest everything they paid, host nothing
//
// ONE copy of this maths, same as the tiers. Do not recompute it
// anywhere else.
// ============================================================

export const NON_TIER_CANCEL_TYPES = ['no_show', 'emergency_no_show', 'platform'];

export function computeNonTierAmounts(booking, cancelType) {
  const base = tierRound2(booking?.base);
  const totalPaid = tierRound2(Number(booking?.amount_paid) || Number(booking?.total) || 0);
  const ct = String(cancelType || '').toLowerCase().trim();

  if (ct === 'no_show') {
    return { guestAmount: 0, hostAmount: base, platformKeeps: tierRound2(totalPaid - base), totalPaid, base };
  }

  if (ct === 'emergency_no_show') {
    // Rounded DOWN to the sen for the guest, remainder to the host, so
    // the two halves add up to the room price exactly.
    const guestAmount = Math.floor(base * 50) / 100;
    const hostAmount = tierRound2(base - guestAmount);
    return { guestAmount, hostAmount, platformKeeps: tierRound2(totalPaid - guestAmount - hostAmount), totalPaid, base };
  }

  if (ct === 'platform') {
    return { guestAmount: totalPaid, hostAmount: 0, platformKeeps: 0, totalPaid, base };
  }

  return { guestAmount: 0, hostAmount: 0, platformKeeps: tierRound2(totalPaid), totalPaid, base, unknownType: ct || '(empty)' };
}

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

// ============================================================
// HTML / URL escaping
// ============================================================

export function escHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same as escHtml in practice — quotes must be escaped in attribute
// context too. Exported under both names so call sites can read clearly.
export function escAttr(value) {
  return escHtml(value);
}

// Only allow http(s) URLs. Anything else (javascript:, data:, etc.)
// becomes an empty string so it doesn't end up in an href/src.
export function safeUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

// ============================================================
// b64url / HMAC
// ============================================================

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

// Constant-time byte comparison. Used for password verification.
function constantTimeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Constant-time string compare. Hashing both sides first makes the loop
// length independent of the inputs, which is what we want.
async function constantTimeEqualStrings(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b))
  ]);
  return constantTimeEqualBytes(new Uint8Array(ha), new Uint8Array(hb));
}

// ============================================================
// Signed tokens
// ============================================================

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

// ============================================================
// User records / session versioning
// ============================================================

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
  const record = await getUserRecord('guest', payload.userId, db);
  if (!record) return null;

  // FAIL CLOSED. If either side is missing, treat as version 0 and
  // compare. So a token with no version only matches a record with no
  // version (or version 0). A token with version N only matches a
  // record with version N.
  const recVer = Number(record.sessionVersion ?? 0);
  const tokVer = Number(payload.sessionVersion ?? 0);
  if (recVer !== tokVer) return null;

  return payload;
}

export async function getOwnerSession(request, env) {
  const token = getBearerToken(request, 'Owner-Authorization') || getCookie(request, 'owner_token');
  if (!token) return null;
  const payload = await verifySignedToken(token, env);
  if (!payload || payload.type !== 'owner') return null;

  const db = env.DB;
  if (!db) return null;
  const record = await getUserRecord('owner', payload.ownerId, db);
  if (!record) return null;

  // FAIL CLOSED. If we found the owner, their max session version must
  // match the token's. A missing version on either side = 0.
  const { found, maxVersion } = await getOwnerMaxSessionVersion(db, payload.ownerId);
  if (found) {
    const tokVer = Number(payload.ownerSessionVersion ?? 0);
    if (Number(maxVersion) !== tokVer) return null;
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

// ============================================================
// Request helpers
// ============================================================

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

// Only trust CF-Connecting-IP (set by Cloudflare and not spoofable).
// X-Forwarded-For is client-controllable if the request ever reaches us
// through a non-Cloudflare proxy, so we don't fall back to it anymore.
export function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
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
    // CSP deliberately NOT set on JSON responses:
    //   - A JSON body cannot execute scripts, so CSP is inert here.
    //   - Setting it on every /api/* call was wasted bytes.
    //   - The real CSP for HTML pages lives in /_headers at the site root.
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
    // 308 (not 301) so the method and body are preserved. 301 on a POST
    // silently converts the request to GET and drops the body.
    return new Response(null, { status: 308, headers: { Location: url.toString() } });
  }
  return null;
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

// ============================================================
// Rate limiting
// ============================================================

const _rateLimitTableReady = new Set();

export async function ensureRateLimitTable(db) {
  if (!db) return;
  if (_rateLimitTableReady.has('rate_limits')) return;
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
  _rateLimitTableReady.add('rate_limits');
}

// By default, FAIL CLOSED: if the DB errors, deny the request. This is
// the safe default for auth and money endpoints. Pass { failOpen: true }
// for endpoints where availability matters more than strictness.
export async function checkRateLimit(db, ip, action, maxAttempts, windowSeconds = 60, opts = {}) {
  const failOpen = opts.failOpen === true;
  if (!db || !ip) return failOpen;
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
    return failOpen;
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

// ============================================================
// Session version invalidation
// ============================================================

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

// ============================================================
// Passwords
// ============================================================

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

// PASSWORD_PEPPER is now REQUIRED. Do not fall back to SESSION_SECRET.
// If you rotate SESSION_SECRET with the old fallback in place, every
// password hash becomes unverifiable and every user is locked out.
function requirePasswordPepper(env) {
  const pepper = env?.PASSWORD_PEPPER;
  if (!pepper || pepper.length < 16) {
    throw new Error('PASSWORD_PEPPER is required and must be at least 16 characters');
  }
  return pepper;
}

export async function hashPassword(password, env, salt = generateSalt()) {
  const pepper = requirePasswordPepper(env);
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

  let pepper;
  try {
    pepper = requirePasswordPepper(env);
  } catch (_) {
    return { ok: false, legacy: false };
  }

  if (algorithm && algorithm.startsWith('PBKDF2-')) {
    const parts = algorithm.split('-');
    const iterations = parts.length >= 2 ? parseInt(parts[1], 10) : DEFAULT_PBKDF2_ITERATIONS;
    const useIterations = (isNaN(iterations) || iterations <= 0)
      ? DEFAULT_PBKDF2_ITERATIONS
      : iterations;
    const computed = await derivePassword(password, salt, pepper, useIterations);
    // Constant-time compare.
    const ok = await constantTimeEqualStrings(computed, hash);
    return { ok, legacy: false };
  }

  // Legacy (pre-PBKDF2) hash. Requires LEGACY_PASSWORD_PEPPER to be set.
  // No hardcoded fallback — fail closed if it's missing.
  const legacyPepper = env?.LEGACY_PASSWORD_PEPPER;
  if (!legacyPepper) {
    return { ok: false, legacy: true };
  }
  const computedLegacy = await sha256(legacyPepper + password + salt);
  const ok = await constantTimeEqualStrings(computedLegacy, hash);
  return { ok, legacy: true };
}

// ============================================================
// Audit log
// ============================================================

const _auditTableReady = new Set();

export async function logAction({ db, action, admin, details, ip, userId, homestayId }) {
  try {
    if (!_auditTableReady.has('audit_log')) {
      await db.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT, action TEXT, admin TEXT, user_id TEXT,
        homestay_id TEXT, details TEXT, ip TEXT
      )`).run();
      _auditTableReady.add('audit_log');
    }
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

// ============================================================
// CSRF
// ============================================================

const CSRF_TTL_MS = 60 * 60 * 1000;

export async function generateCSRFToken(userId, env, sessionVersion = 0) {
  return createSignedToken(
    {
      type: 'csrf',
      userId: String(userId),
      sv: Number(sessionVersion) || 0
    },
    env,
    CSRF_TTL_MS
  );
}

export async function validateCSRFToken(token, userId, env, sessionVersion = 0) {
  const data = await verifySignedToken(token, env);
  if (!data) return false;
  if (data.type !== 'csrf') return false;
  if (String(data.userId) !== String(userId)) return false;
  const expectedSv = Number(sessionVersion) || 0;
  const tokenSv = Number(data.sv ?? 0);
  if (tokenSv !== expectedSv) return false;
  return true;
}

export function getCSRFToken(request) {
  return request.headers.get('X-CSRF-Token') || null;
}

// ============================================================
// Admin auth
// ============================================================

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

// ============================================================
// Sanitizers and validators
// ============================================================

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

// ============================================================
// Check-in attempts
// ============================================================

const _checkinAttemptsReady = new Set();

async function ensureCheckinAttemptsTable(db) {
  if (_checkinAttemptsReady.has('checkin_attempts')) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS checkin_attempts (
      booking_id TEXT,
      attempt_time INTEGER,
      PRIMARY KEY (booking_id, attempt_time)
    )`
  ).run();
  _checkinAttemptsReady.add('checkin_attempts');
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

// ============================================================
// Distributed lock
// ============================================================

const _locksTableReady = new Set();

async function ensureLocksTable(db) {
  if (_locksTableReady.has('homestay_locks')) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS homestay_locks (
      homestay_id TEXT PRIMARY KEY,
      locked_at INTEGER
    )`
  ).run();
  _locksTableReady.add('homestay_locks');
}

// Default stale timeout raised 5s → 30s. Webhook/lock operations that
// call CHIP can take longer than 5s. Under 5s, a second process can
// steal the lock while the first is still mid-flight.
const LOCK_STALE_MS = 60000;
export async function withLock(db, lockKey, callback, staleTimeoutMs = LOCK_STALE_MS) {
  await ensureLocksTable(db);

  // BUG FIX: staleness used to be compared against the LOCK_STALE_MS
  // constant, which silently ignored the staleTimeoutMs argument. Every
  // caller's explicit timeout was therefore inert — including the
  // 120000 in withdraw.js, which exists precisely because a CHIP Send
  // call can outlast a minute. The lock became stealable after 60s
  // regardless, so a second request could start a duplicate money
  // operation while the first was still in flight.
  //
  // Also guard the caller's value: 0, a negative number or NaN would
  // make every lock instantly stealable, which is worse than the
  // original bug.
  const effectiveStaleMs =
    (Number.isFinite(staleTimeoutMs) && staleTimeoutMs > 0)
      ? staleTimeoutMs
      : LOCK_STALE_MS;

  const myLockValue = Date.now();

  let insertResult = await db.prepare(
    `INSERT OR IGNORE INTO homestay_locks (homestay_id, locked_at) VALUES (?, ?)`
  ).bind(lockKey, myLockValue).run();

  if (insertResult.meta.changes === 0) {
    const existing = await db.prepare(
      `SELECT locked_at FROM homestay_locks WHERE homestay_id = ?`
    ).bind(lockKey).first();

  if (existing && (myLockValue - existing.locked_at) > effectiveStaleMs) {
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

// ============================================================
// Email — one provider-selection helper for the whole codebase
// ============================================================

// sendEmail({ to, subject, html, text, replyTo }, env)
// Returns { sent: boolean, error: string|null, provider: string|null }
export async function sendEmail({ to, subject, html, text, replyTo }, env) {
  if (!to) return { sent: false, error: 'No recipient', provider: null };
  if (!html && !text) return { sent: false, error: 'No body', provider: null };

  // Sanitize header inputs — strip CR/LF to prevent header injection.
  const cleanSubject = String(subject || '').replace(/[\r\n]+/g, ' ').slice(0, 400);
  const cleanTo = String(to).replace(/[\r\n]+/g, '').trim();

  if (env.RESEND_API_KEY) {
    try {
      const body = {
        from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
        to: cleanTo,
        subject: cleanSubject,
        html: html || undefined,
        text: text || undefined
      };
      if (replyTo) body.reply_to = String(replyTo).replace(/[\r\n]+/g, '').trim();

      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!r.ok) {
        let msg = 'Resend API error';
        try { const d = await r.json(); if (d?.message) msg = d.message; } catch (_) {}
        return { sent: false, error: msg, provider: 'resend' };
      }
      return { sent: true, error: null, provider: 'resend' };
    } catch (e) {
      return { sent: false, error: e.message, provider: 'resend' };
    }
  }

  if (env.SENDGRID_API_KEY) {
    try {
      const content = [];
      if (text) content.push({ type: 'text/plain', value: text });
      if (html) content.push({ type: 'text/html', value: html });
      const body = {
        personalizations: [{ to: [{ email: cleanTo }] }],
        from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
        subject: cleanSubject,
        content
      };
      if (replyTo) body.reply_to = { email: String(replyTo).replace(/[\r\n]+/g, '').trim() };

      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!r.ok) return { sent: false, error: 'SendGrid API error', provider: 'sendgrid' };
      return { sent: true, error: null, provider: 'sendgrid' };
    } catch (e) {
      return { sent: false, error: e.message, provider: 'sendgrid' };
    }
  }

  return { sent: false, error: 'No email provider configured', provider: null };
}

// ============================================================
// Canonical guest check-in email
//
// One version of this template for the whole codebase. Callers that
// previously had their own local copies (chip-webhook.js, verify-payment.js,
// chip-create.js) should now import this one instead.
// ============================================================

export async function sendCheckinEmail(booking, env) {
  if (!booking || !booking.guestEmail) {
    return { sent: false, error: 'No guest email on file' };
  }

  const nights = Number(booking.nights) || 1;
  const nightLabel = nights === 1 ? 'night' : 'nights';
  const base = Number(booking.base || 0);
  const fee = Number(booking.fee || 0);
  const gatewayFee = Number(booking.gatewayFee || 0);
  const combinedFee = Math.round((fee + gatewayFee) * 100) / 100;
  const total = Number(booking.total || 0);
  const pricePerNight = nights > 0 ? base / nights : base;
  const receiptNo = String(booking.receiptNo || `RCP-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(booking.id || '').slice(-6)}`);

  const e = escHtml;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>Your Receipt</title>
</head>
<body style="margin:0;padding:0;background-color:#f8f5f0;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8f5f0;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;border:1px solid #e5e7eb;">
        <tr>
          <td style="padding:36px 32px 28px 32px;">
            <div style="text-align:center;padding-bottom:20px;border-bottom:2px solid #0F382E;">
              <div style="font-size:22px;font-weight:800;color:#0F382E;letter-spacing:-0.3px;line-height:1.2;">Kundasang Homestay</div>
              <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:2px;margin-top:6px;">Official Receipt</div>
            </div>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
              <tr><td style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;padding-bottom:4px;">Booking ID</td></tr>
              <tr><td style="font-family:'Courier New',Consolas,monospace;font-size:17px;font-weight:700;color:#dc2626;padding-bottom:16px;letter-spacing:0.5px;word-break:break-all;">${e(booking.id)}</td></tr>
              <tr><td style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;padding-bottom:4px;">Receipt No.</td></tr>
              <tr><td style="font-family:'Courier New',Consolas,monospace;font-size:13px;color:#4b5563;letter-spacing:0.4px;word-break:break-all;">${e(receiptNo)}</td></tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#6b7280;width:110px;vertical-align:top;">Guest</td>
                <td style="padding:8px 0;font-size:14px;color:#212121;font-weight:600;">${e(booking.guestName) || 'Guest'}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#6b7280;vertical-align:top;">Homestay</td>
                <td style="padding:8px 0;font-size:14px;color:#212121;font-weight:600;">${e(booking.homestay)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#6b7280;vertical-align:top;">Check-in</td>
                <td style="padding:8px 0;font-size:14px;color:#212121;font-weight:600;">${e(booking.checkin)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#6b7280;vertical-align:top;">Check-out</td>
                <td style="padding:8px 0;font-size:14px;color:#212121;font-weight:600;">${e(booking.checkout)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#6b7280;vertical-align:top;">Nights</td>
                <td style="padding:8px 0;font-size:14px;color:#212121;font-weight:600;">${nights} ${nightLabel}</td>
              </tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
              <tr><td colspan="2" style="border-top:1px dashed #d1d5db;padding-top:20px;"></td></tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#6b7280;">Price (RM ${pricePerNight.toFixed(2)} &times; ${nights} ${nightLabel})</td>
                <td style="padding:8px 0;font-size:13px;color:#212121;text-align:right;font-weight:600;font-family:'Courier New',monospace;">RM ${base.toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#6b7280;">Service Fee</td>
                <td style="padding:8px 0;font-size:13px;color:#212121;text-align:right;font-weight:600;font-family:'Courier New',monospace;">RM ${combinedFee.toFixed(2)}</td>
              </tr>
              <tr><td colspan="2" style="border-top:2px solid #0F382E;padding-top:14px;"></td></tr>
              <tr>
                <td style="padding:6px 0 0 0;font-size:15px;font-weight:700;color:#0F382E;">Total paid</td>
                <td style="padding:6px 0 0 0;font-size:19px;font-weight:800;color:#0F382E;text-align:right;font-family:'Courier New',monospace;">RM ${total.toFixed(2)}</td>
              </tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;">
              <tr>
                <td style="background-color:#f0fdf4;border:2px solid #86efac;border-radius:14px;padding:24px 20px;text-align:center;">
                  <div style="font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Your Check-in Code</div>
                  <div style="font-family:'Courier New',Consolas,monospace;font-size:38px;font-weight:800;color:#0F382E;letter-spacing:10px;line-height:1;padding-left:10px;">${e(booking.checkinCode)}</div>
                  <div style="font-size:12px;color:#166534;margin-top:16px;line-height:1.6;">Share this 6-digit code with the host when you arrive.<br>Do not share it with anyone else.</div>
                </td>
              </tr>
            </table>

            <div style="text-align:center;font-size:11px;color:#9ca3af;margin-top:32px;padding-top:20px;border-top:1px solid #e5e7eb;line-height:1.7;">
              Payment processed via CHIP FPX<br>
              &copy; ${new Date().getFullYear()} Kundasang Homestay
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

    return sendEmail({
    to: booking.guestEmail,
    subject: 'Your Receipt & Check-in Code – ' + String(booking.id || '').replace(/[\r\n]+/g, ''),
    html
  }, env);
}

// ============================================================
// Non-tier cancellation emails (no_show / emergency_no_show / platform)
//
// None of these is the guest's fault in the ordinary sense, so none of
// them may be explained in tier language. The guest is told what
// happened and what they get; the host is told what happened to their
// money.
// ============================================================

const NON_TIER_COPY = {
  no_show: {
    subject: 'Booking No-Show — No Refund Due',
    color: '#6b7280',
    header: 'Booking No-Show'
  },
  emergency_no_show: {
    subject: 'Booking No-Show — Emergency Approved',
    color: '#7c3aed',
    header: 'Booking No-Show — Emergency Approved'
  },
  platform: {
    subject: 'Booking Cancelled by Kundasang Homestay',
    color: '#2563eb',
    header: 'Booking Cancelled by Us'
  }
};

export async function sendNonTierCancellationEmail(booking, info, env) {
  if (!booking || !booking.guestEmail) return { sent: false, error: 'No guest email on file' };

  const e = escHtml;
  const ct = String(info.cancelType || '');
  const copy = NON_TIER_COPY[ct] || { subject: 'Booking Update', color: '#6b7280', header: 'Booking Update' };

  const totalPaidNum = Number(info.totalPaid || booking.amount_paid || booking.total || 0);
  const totalPaid = totalPaidNum.toFixed(2);
  const refundAmount = Number(info.guestAmount || 0).toFixed(2);
  const hostAmount = Number(info.hostAmount || 0).toFixed(2);
  const retained = tierRound2(totalPaidNum - Number(info.guestAmount || 0) - Number(info.hostAmount || 0)).toFixed(2);

  let bodyHtml;
  if (ct === 'no_show') {
    bodyHtml = `
      <p>Your booking at <strong>${e(booking.homestay)}</strong> for <strong>${e(booking.checkin)}</strong> was recorded as a <strong>no-show</strong>.</p>
          <p>We hold your room until 24 hours after your check-in time — 2:00 PM on your arrival date. Because you did not arrive and did not contact your host or us within that time, <strong>no refund is due</strong> under our published policy.</p>
      <p>Your host has been paid the room price of <strong>RM${e(hostAmount)}</strong> for holding the room, which could not be resold at that point. The service and payment fees of RM${e(retained)} are not refundable.</p>
      <p>If you did arrive, or if something happened that stopped you, email <a href="mailto:support@kundasanghomestay.my">support@kundasanghomestay.my</a> with the details. We review genuine emergencies ourselves, and can pay back 50% of the room price.</p>
    `;
  } else if (ct === 'emergency_no_show') {
    bodyHtml = `
      <p>Your booking at <strong>${e(booking.homestay)}</strong> for <strong>${e(booking.checkin)}</strong> was recorded as a no-show, and <strong>we have approved your emergency</strong>.</p>
      <p>Under our published policy, a no-show with an approved emergency settles at <strong>50% of the room price</strong>.</p>
      <p>A refund of <strong>RM${e(refundAmount)}</strong> has been sent back to your original payment method via CHIP. Your host receives the other half.</p>
      <p>Refunds usually take <strong>1–7 business days</strong> to appear in your bank account.</p>
      ${info.refundId ? `<p><strong>Refund reference (CHIP):</strong> ${e(info.refundId)}</p>` : ''}
    `;
  } else {
    bodyHtml = `
      <p>We have had to cancel your booking at <strong>${e(booking.homestay)}</strong> for <strong>${e(booking.checkin)}</strong>.</p>
      <p>This was not your fault, and not your host's. It was decided by us, for reasons outside anyone's control.</p>
      <p><strong>You receive everything you paid — RM${e(totalPaid)}</strong>, including the service fee and the payment fee. Nothing is held back.</p>
      <p>A refund of <strong>RM${e(refundAmount)}</strong> has been sent back to your original payment method via CHIP, and usually takes <strong>1–7 business days</strong> to appear in your bank account.</p>
      ${info.refundId ? `<p><strong>Refund reference (CHIP):</strong> ${e(info.refundId)}</p>` : ''}
    `;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:${copy.color};">${copy.header}</h2>
      <p>Hello ${e(booking.guestName) || 'Guest'},</p>
      ${bodyHtml}
      <div style="background:#f8f5f0;padding:16px;border-radius:8px;margin:16px 0;font-size:13px;">
        <div><strong>Booking ID:</strong> ${e(booking.id)}</div>
        <div><strong>Homestay:</strong> ${e(booking.homestay)}</div>
        <div><strong>Check-in:</strong> ${e(booking.checkin)}</div>
        <div><strong>Check-out:</strong> ${e(booking.checkout)}</div>
      </div>
      <p>— Kundasang Homestay Team</p>
    </div>
  `;

  return sendEmail({ to: booking.guestEmail, subject: copy.subject, html }, env);
}

export async function sendNonTierHostNotice(booking, homestay, info, env) {
  if (!homestay || !homestay.ownerEmail) return { sent: false, error: 'No host email on file' };

  const e = escHtml;
  const ct = String(info.cancelType || '');
  const ownerName = e(homestay.ownerName || 'Host');
  const hostAmount = Number(info.hostAmount || 0).toFixed(2);

  let subject, headline, bodyHtml;
  if (ct === 'no_show') {
    subject = `Booking ${String(booking.id || '').replace(/[\r\n]+/g, '')} — Guest Did Not Arrive`;
    headline = 'Guest Did Not Arrive';
    bodyHtml = `
      <p>The guest on booking <strong>${e(booking.id)}</strong> for <strong>${e(booking.checkin)}</strong> did not arrive, and did not contact you or us within 24 hours.</p>
      <p>Under our published policy the room price is yours, because the room was held and could not be resold at that point.</p>
      <p><strong>RM${e(hostAmount)} has been added to your payout queue.</strong> It will be paid to your bank account in the normal way, and you will get a separate payout statement when it is sent.</p>
      <p>The guest has been told. If they get in touch and you believe there was a genuine emergency, tell us at <a href="mailto:support@kundasanghomestay.my">support@kundasanghomestay.my</a> and we will review it.</p>
    `;
  } else if (ct === 'emergency_no_show') {
    subject = `Booking ${String(booking.id || '').replace(/[\r\n]+/g, '')} — Emergency No-Show Approved`;
    headline = 'Emergency No-Show Approved';
    bodyHtml = `
      <p>We have reviewed the no-show on booking <strong>${e(booking.id)}</strong> for <strong>${e(booking.checkin)}</strong> and <strong>approved the guest's emergency</strong>.</p>
      <p>Under our published policy, a no-show with an approved emergency settles at 50% of the room price for each side.</p>
      <p><strong>Your share is RM${e(hostAmount)}</strong>, and it has been added to your payout queue.</p>
      <p>We make these decisions ourselves, so you are never asked to judge your own refund. If you think this is wrong, reply to this email.</p>
    `;
  } else {
    subject = `Booking ${String(booking.id || '').replace(/[\r\n]+/g, '')} — Cancelled by Kundasang Homestay`;
    headline = 'Booking Cancelled by Us';
    bodyHtml = `
      <p>We have had to cancel booking <strong>${e(booking.id)}</strong> for <strong>${e(booking.checkin)}</strong>.</p>
      <p>This was not caused by you, and not by the guest. It was decided by us, for reasons outside anyone's control.</p>
      <p><strong>The guest is refunded in full, and no payout is due to you for this booking.</strong> We are sorry — we know that is a lost night.</p>
      <p>There is nothing you need to do. If you have any questions, reply to this email.</p>
    `;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#0F382E;">${headline}</h2>
      <p>Hello ${ownerName},</p>
      ${bodyHtml}
      <div style="background:#f8f5f0;padding:16px;border-radius:8px;margin:16px 0;font-size:13px;">
        <div><strong>Booking ID:</strong> ${e(booking.id)}</div>
        <div><strong>Homestay:</strong> ${e(booking.homestay)}</div>
        <div><strong>Guest:</strong> ${e(booking.guestName) || 'Guest'}</div>
        <div><strong>Check-in:</strong> ${e(booking.checkin)}</div>
      </div>
      <p>— Kundasang Homestay Team</p>
    </div>
  `;

  return sendEmail({ to: homestay.ownerEmail, subject, html }, env);
}

// ============================================================
// Canonical refund email (properly escaped)
// ============================================================

export async function sendRefundEmail(booking, env) {
  if (!booking || !booking.guestEmail) {
    return { sent: false, error: 'No guest email on file' };
  }

  const refundAmount = Number(booking.refund_amount || booking.amount_paid || booking.total || 0);
  const refundId = String(booking.chip_refund_id || 'N/A');
  const e = escHtml;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2>Hello ${e(booking.guestName) || 'Guest'},</h2>
      <p>Your booking <strong>${e(booking.id)}</strong> at <strong>${e(booking.homestay)}</strong> has been <strong>cancelled and refunded</strong>.</p>
      <p><strong>Refund Amount:</strong> RM ${refundAmount.toFixed(2)}</p>
      <p><strong>Refund ID (CHIP):</strong> ${e(refundId)}</p>
      <p>If you have any questions, please contact the host or our support team.</p>
      <p>— Kundasang Homestay Team</p>
    </div>
  `;

  return sendEmail({
    to: booking.guestEmail,
    subject: 'Refund Confirmation – Booking ' + String(booking.id || '').replace(/[\r\n]+/g, ''),
    html
  }, env);
}

// ============================================================
// Auto-refund for late payments
//
// CANONICAL version. Previously duplicated across chip-webhook.js,
// verify-payment.js, and chip-create.js — now lives here only. Callers
// MUST hold the per-booking lock before invoking this.
// ============================================================

export async function tryAutoRefundLatePaymentLocked(db, bookingId, env) {
  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
  const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
  if (idx === -1) return { error: 'Booking not found' };
  const b = bookings[idx];

  if (b.chip_refund_id) {
    return { alreadyRefunded: true, refundId: b.chip_refund_id };
  }
  if (!b.chip_purchase_id) {
    return { error: 'No chip_purchase_id to refund' };
  }

  const secret = env.CHIP_SECRET_KEY;
  if (!secret) return { error: 'CHIP_SECRET_KEY missing' };

  // Refund the amount CHIP actually collected.
  const refundAmountCents = Math.round(Number(b.amount_paid || b.total) * 100);

  try {
    const res = await fetch(
      `https://gate.chip-in.asia/api/v1/purchases/${b.chip_purchase_id}/refund/`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secret}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ amount: refundAmountCents })
      }
    );
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }

    if (!res.ok || !data || !data.id) {
      return { error: `CHIP refund failed: ${data?.error || 'unknown'}` };
    }

    const isPending = data.status === 'pending_refund';

    bookings[idx].status = isPending ? 'Refund Pending - Awaiting CHIP' : 'Refunded - Late Payment';
    bookings[idx].chip_refund_id = data.id;
    bookings[idx].refunded_at = new Date().toISOString();
    bookings[idx].refund_amount = Number(b.amount_paid || b.total) || 0;
    bookings[idx].late_payment_refund = true;
    if (isPending) bookings[idx].refund_pending = true;

    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    return { success: true, refundId: data.id, pending: isPending };
  } catch (e) {
    return { error: `Refund network error: ${e.message}` };
  }
}

// ============================================================
// finalizePaidBooking
//
// Idempotent. When it finalizes a booking for the first time it also
// sets two new fields:
//   - checkin_email_status = 'pending'  (later set to 'sent' or 'failed')
//   - receiptNo                         (stable, generated once)
//
// CALLER MUST HOLD THE BOOKING LOCK. (Same requirement as before; the
// function was never safe to call without a lock, and now it's even
// more important because we care about not double-emailing.)
// ============================================================

function generateCheckinCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

function generateReceiptNo(booking) {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
  const idPart = String(booking.id || '').replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase() || 'XXXXXX';
  return `RCP-${ymd}-${idPart}`;
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
  const code = booking.checkinCode || generateCheckinCode();

  const updated = {
    ...booking,
    status: 'Paid - Awaiting Check-in',
    checkinCode: code,
    // Persist the receipt number once. Never regenerate.
    receiptNo: booking.receiptNo || generateReceiptNo(booking),
    // Email tracking. Only set to 'pending' if it's not already set.
    checkin_email_status: booking.checkin_email_status || 'pending',
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

// Best-effort update of checkin_email_status. Re-reads the booking and
// patches only that field, so it can't clobber concurrent updates to
// other fields. Runs its own short-lived lock.
async function markCheckinEmailStatus(db, bookingId, status) {
  try {
    await withLock(db, 'bookings-global', async (db) => {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
      let bookings = [];
      try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
      const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
      if (idx === -1) return;
      bookings[idx] = { ...bookings[idx], checkin_email_status: status };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
    }, 60000);
  } catch (_) {
    // Best effort — if we can't update the flag, the next finalize
    // pass will try again.
  }
}

// ============================================================
// finalizeAndNotify
//
// One function that does the whole "payment confirmed" flow:
//   - Takes the per-booking lock
//   - Calls finalizePaidBooking (idempotent)
//   - If the booking was cancelled before payment settled, auto-refunds
//   - Sends the check-in email. Retries if a previous attempt failed.
//   - Does NOT log to audit_log — the caller does, because the caller
//     knows the source (webhook vs verify-payment vs chip-create).
//
// Returns:
//   {
//     outcome: 'finalized' | 'already_finalized' | 'refused' | 'error' | 'lock_busy',
//     booking: object|null,       // current booking record
//     checkinCode: string|null,   // set when outcome is finalized/already_finalized
//     refundResult: object|null,  // set when outcome === 'refused'
//     emailSent: boolean,
//     emailError: string|null,
//     error: string|null,
//     retryable: boolean          // if true, caller should return 500 so CHIP retries
//   }
// ============================================================

export async function finalizeAndNotify(db, bookingId, env, ctx = {}) {
  const result = {
    outcome: 'error',
    booking: null,
    checkinCode: null,
    refundResult: null,
    emailSent: false,
    emailError: null,
    error: null,
    retryable: false
  };

  let lockResult;
  try {
    lockResult = await withLock(db, 'bookings-global', async (db) => {
      const finalizeResult = await finalizePaidBooking(db, bookingId);
      if (finalizeResult.error) return { finalizeResult };
      if (finalizeResult.refuseFinalize) {
        const refundResult = await tryAutoRefundLatePaymentLocked(db, bookingId, env);
        return { finalizeResult, refundResult };
      }
      return { finalizeResult };
    }, 60000);
  } catch (lockErr) {
    if (lockErr.message && lockErr.message.includes('in progress')) {
      // Another process holds the lock. Wait briefly, then re-read.
      await new Promise(res => setTimeout(res, 1500));
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
      let bb = [];
      try { if (r?.data) bb = JSON.parse(r.data); } catch(_) {}
      const cur = bb.find(b => String(b.id) === String(bookingId));
      if (cur && (cur.status === 'Paid - Awaiting Check-in' || String(cur.status).startsWith('Completed'))) {
        result.outcome = 'already_finalized';
        result.booking = cur;
        result.checkinCode = cur.checkinCode || null;
        // If a previous pass failed to email, try now.
        if (cur.checkin_email_status !== 'sent' && cur.guestEmail) {
          const er = await sendCheckinEmail(cur, env);
          result.emailSent = er.sent;
          result.emailError = er.sent ? null : er.error;
          if (er.sent) await markCheckinEmailStatus(db, bookingId, 'sent');
        }
        return result;
      }
      result.outcome = 'lock_busy';
      result.error = 'Another confirmation is in progress';
      result.retryable = true;
      return result;
    }
    result.outcome = 'error';
    result.error = lockErr.message || 'Lock error';
    result.retryable = true;
    return result;
  }

  const fr = lockResult.finalizeResult;

  if (fr.error) {
    result.outcome = 'error';
    result.error = fr.error;
    result.booking = fr.booking || null;
    // "Guest account has been deleted" is a permanent condition, not retryable.
    // Any other error is retryable.
    result.retryable = !/deleted/i.test(fr.error);
    return result;
  }

  if (fr.refuseFinalize) {
  result.outcome = 'refused';
  result.booking = fr.booking;
  result.refundResult = lockResult.refundResult || { error: 'refund not attempted' };
  result.refuseReason = fr.reason || null;
  return result;
  }

  if (fr.alreadyFinalized) {
    result.outcome = 'already_finalized';
    result.booking = fr.booking;
    result.checkinCode = fr.booking.checkinCode || null;

    // Retry the email if it wasn't confirmed sent.
    if (fr.booking.checkin_email_status !== 'sent' && fr.booking.guestEmail) {
      const er = await sendCheckinEmail(fr.booking, env);
      result.emailSent = er.sent;
      result.emailError = er.sent ? null : er.error;
      if (er.sent) await markCheckinEmailStatus(db, bookingId, 'sent');
    }
    return result;
  }

  if (fr.finalized) {
    result.outcome = 'finalized';
    result.booking = fr.booking;
    result.checkinCode = fr.checkinCode;

    // Send only if the code was newly generated OR a previous send failed.
    // (If code already existed and email was already sent, don't re-send.)
    const shouldEmail = fr.codeWasMissing || fr.booking.checkin_email_status !== 'sent';
    if (shouldEmail) {
      const er = await sendCheckinEmail(fr.booking, env);
      result.emailSent = er.sent;
      result.emailError = er.sent ? null : er.error;
      if (er.sent) await markCheckinEmailStatus(db, bookingId, 'sent');
    }
    return result;
  }

    result.outcome = 'error';
  result.error = 'Unexpected finalize result';
  result.retryable = true;
  return result;
}

// ============================================================
// NO-SHOW SWEEP  ⚪
//
// Pages Functions have no cron trigger, so the 24-hour rule runs as a
// SWEEP: it is called when an admin loads the dashboard, and at most
// once every 10 minutes. If nobody opens the dashboard for a week,
// nothing is marked until they do. The AMOUNT is the same whenever it
// runs — only the notification is late.
//
// It NEVER calls CHIP. A no-show owes the guest nothing, so there is no
// refund to make. All it does is queue the host's room price into the
// same manual payout queue a check-in uses — and payout.js pays a host
// exactly Number(booking.base), which is the same figure. So if this
// ever fires wrongly the host is paid what a check-in would have paid
// them anyway, and no money can move the wrong way.
//
// Deadline: 24 hours after the published check-in time — 2:00 PM MYT
// (06:00 UTC) on the arrival date. A 24 Sept arrival is swept from
// 25 Sept 2:00 PM MYT.
// ============================================================

export const NO_SHOW_GRACE_MS = 24 * 60 * 60 * 1000;
const NO_SHOW_SWEEP_THROTTLE_MS = 10 * 60 * 1000;
const NO_SHOW_CHIP_PAYMENT_FEE = 1.00;

export function noShowDeadlineMs(checkin) {
  const s = String(checkin || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const checkinMs = Date.parse(s + 'T06:00:00Z');
  if (!Number.isFinite(checkinMs)) return NaN;
  return checkinMs + NO_SHOW_GRACE_MS;
}

export function isNoShowDue(booking, now = Date.now()) {
  if (String(booking?.status || '') !== 'Paid - Awaiting Check-in') return false;

  // A guest who has ASKED to cancel and is still waiting for a decision
  // must NOT be swept. Their entitlement is already fixed by the date
  // they asked; turning that into a no-show would give them nothing and
  // contradict the published tiers.
  const req = booking?.cancellationRequest;
  if (req && req.status === 'pending_host') return false;

  const deadline = noShowDeadlineMs(booking?.checkin);
  if (!Number.isFinite(deadline)) return false;
  return now >= deadline;
}

export async function sweepNoShows(db, env, { now = Date.now(), force = false } = {}) {
  const summary = { ran: false, scanned: 0, marked: 0, bookingIds: [], emailsSent: 0, error: null };
  if (!db) { summary.error = 'no db'; return summary; }

  if (!force) {
    try {
      const st = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_no_show_sweep').first();
      let last = 0;
      try { if (st?.data) last = Number(JSON.parse(st.data)?.lastRunAt) || 0; } catch (_) {}
      if (last && (now - last) < NO_SHOW_SWEEP_THROTTLE_MS) return summary;
    } catch (_) {}
  }

  let locked;
  try {
    locked = await withLock(db, 'bookings-global', async (db) => {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
      let bookings = [];
      try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
      if (!Array.isArray(bookings)) bookings = [];

      const dueIdx = [];
      for (let i = 0; i < bookings.length; i++) {
        if (String(bookings[i]?.status || '') === 'Paid - Awaiting Check-in') summary.scanned++;
        if (isNoShowDue(bookings[i], now)) dueIdx.push(i);
      }
      if (dueIdx.length === 0) return { marked: 0, ids: [], dueBookings: [] };

      const homes = new Map();
      for (const key of ['kd_approved', 'kd_homestays', 'kd_pending']) {
        try {
          const hr = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();
          let list = [];
          try { if (hr?.data) list = JSON.parse(hr.data); } catch (_) {}
          for (const h of (Array.isArray(list) ? list : [])) {
            if (!homes.has(String(h.id))) homes.set(String(h.id), h);
          }
        } catch (_) {}
      }

      const feeRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_fee_earnings').first();
      let feeEarnings = feeRes?.data ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
      feeEarnings.history = Array.isArray(feeEarnings.history) ? feeEarnings.history : [];

      const chipRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_chip_costs').first();
      let chipCosts = chipRes?.data ? JSON.parse(chipRes.data) : { total: 0, history: [] };
      chipCosts.history = Array.isArray(chipCosts.history) ? chipCosts.history : [];

      let feeDirty = false;
      let chipDirty = false;
      const stamp = new Date(now).toISOString();
      const ids = [];

      for (const i of dueIdx) {
        const b = bookings[i];
        const h = homes.get(String(b.homestayId)) || null;
        const amounts = computeNonTierAmounts(b, 'no_show');

        b.status = 'No-Show - Nothing Due';
        b.cancelled_by = 'system';
        b.cancel_type = 'no_show';
        b.cancellation_tier = null;
        b.cancel_reason = 'Guest did not arrive and made no contact within 24 hours of the arrival date.';
        b.noShowDetectedAt = stamp;
        b.refund_amount = 0;
        b.statusUpdated = stamp;

        if (amounts.hostAmount > 0) {
          b.manualPayoutPending = true;
          b.manualPayoutAmount = amounts.hostAmount;
          b.manualPayoutQueuedAt = stamp;
          b.manualPayoutKind = 'cancellation';
          b.manualPayoutReason = 'No-show — the room was held and could not be resold';
          b.manualPayoutHostName = h?.ownerName || '';
          b.manualPayoutHostEmail = h?.ownerEmail || '';
          b.manualPayoutHostWhatsapp = h?.whatsapp || '';
          b.manualPayoutBankName = h?.ownerBank || '';
          b.manualPayoutBankCode = h?.bankCode || '';
          b.manualPayoutAccountNumber = h?.ownerBankAccount || '';
          b.manualPayoutAccountHolder = h?.bankHolder || '';
          b.manualPayoutHomestayName = h?.name || b.homestay || '';
        }

        const feeAlready = feeEarnings.history.some(x =>
          String(x.bookingId) === String(b.id) &&
          (x.type === 'earning' || x.type === 'cancellation_retained_fee')
        );
        if (!feeAlready && amounts.platformKeeps > 0) {
          feeEarnings.total = tierRound2((feeEarnings.total || 0) + amounts.platformKeeps);
          feeEarnings.available = tierRound2((feeEarnings.available || 0) + amounts.platformKeeps);
          feeEarnings.history.push({
            bookingId: b.id,
            fee: amounts.platformKeeps,
            date: stamp,
            type: 'cancellation_retained_fee',
            cancellation_type: 'no_show',
            cancellation_tier: null,
            original_amount_paid: amounts.totalPaid,
            refunded_amount: 0,
            paid_to_host: amounts.hostAmount,
            method: 'no_show_sweep',
            ip: 'sweep'
          });
          feeDirty = true;
        }

        // No refund was made, so only the payment fee applies here.
        const chipAlready = chipCosts.history.some(x =>
          String(x.bookingId) === String(b.id) && x.type === 'cancellation'
        );
        if (!chipAlready) {
          chipCosts.total = tierRound2((chipCosts.total || 0) + NO_SHOW_CHIP_PAYMENT_FEE);
          chipCosts.history.push({
            bookingId: b.id,
            amount: NO_SHOW_CHIP_PAYMENT_FEE,
            payment_fee: NO_SHOW_CHIP_PAYMENT_FEE,
            refund_fee: 0,
            date: stamp,
            type: 'cancellation',
            cancellation_type: 'no_show',
            cancellation_tier: null,
            method: 'no_show_sweep',
            ip: 'sweep'
          });
          chipDirty = true;
        }

        ids.push(String(b.id));
      }

      const stmts = [db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))];
      if (feeDirty) {
        stmts.push(db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_fee_earnings', JSON.stringify(feeEarnings)));
      }
      if (chipDirty) {
        stmts.push(db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_chip_costs', JSON.stringify(chipCosts)));
      }
      await db.batch(stmts);

      return { marked: ids.length, ids, dueBookings: dueIdx.map(i => bookings[i]) };
    }, 60000);
  } catch (e) {
    if (e.message && e.message.includes('in progress')) { summary.error = 'lock busy'; return summary; }
    summary.error = e.message;
    return summary;
  }

  summary.ran = true;
  summary.marked = locked.marked;
  summary.bookingIds = locked.ids;

  // Notices go out AFTER the lock is released — email is slow and must
  // not hold the bookings lock.
  for (const b of (locked.dueBookings || [])) {
    try {
      const homestay = await findHomestayForEmail(db, b.homestayId);
      const guestResult = await sendNonTierCancellationEmail(b, {
        cancelType: 'no_show',
        guestAmount: 0,
        hostAmount: Number(b.manualPayoutAmount) || 0,
        totalPaid: Number(b.amount_paid) || Number(b.total) || 0,
        refundSuccess: false,
        refundId: null
      }, env);
      if (guestResult.sent) summary.emailsSent++;

      if (homestay) {
        await sendNonTierHostNotice(b, homestay, {
          cancelType: 'no_show',
          guestAmount: 0,
          hostAmount: Number(b.manualPayoutAmount) || 0
        }, env);
      }

      await logAction({
        db,
        action: 'booking_no_show_swept',
        admin: 'system',
        details: `Booking ${b.id} auto-marked as a no-show (arrival ${b.checkin}, 24h grace passed). Guest refund: none due. Host payout queued: RM${(Number(b.manualPayoutAmount) || 0).toFixed(2)}. Guest email: ${guestResult.sent ? 'sent' : 'failed — ' + (guestResult.error || 'unknown')}.`,
        ip: 'sweep',
        userId: b.guestEmail,
        homestayId: b.homestayId
      });
    } catch (e) {
      console.error('No-show notice failed for', b.id, e.message);
    }
  }

  try {
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_no_show_sweep', JSON.stringify({
        lastRunAt: now,
        lastRunAtIso: new Date(now).toISOString(),
        lastMarked: summary.marked
      }))
      .run();
  } catch (_) {}

  return summary;
}

async function findHomestayForEmail(db, homestayId) {
  for (const key of ['kd_approved', 'kd_homestays', 'kd_pending']) {
    try {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();
      let list = [];
      try { if (r?.data) list = JSON.parse(r.data); } catch (_) {}
      const found = (Array.isArray(list) ? list : []).find(x => String(x.id) === String(homestayId));
      if (found) return found;
    } catch (_) {}
  }
  return null;
}

// ============================================================
// Host payout statement email
// ============================================================

function cloudinaryEmailUrl(url) {
  if (!url) return '';
  const idx = url.indexOf('/upload/');
  if (idx === -1) return url;
  const after = url.slice(idx + 8);
  const m = after.match(/^(v\d+\/)/);
  if (!m) return url;
  return url.slice(0, idx + 8) + 'w_600,q_auto,f_auto/' + m[1] + after.slice(m[1].length);
}

export async function sendHostPayoutEmail(booking, homestay, payoutInfo, env) {
  if (!homestay || !homestay.ownerEmail) {
    return { sent: false, error: 'No host email on file' };
  }
  const e = escHtml;
  const isSimulation = !!payoutInfo.isSimulation;
  const isManual = !!payoutInfo.isManual;

  const ownerName = e(homestay.ownerName || 'Host');
  const homestayName = e(homestay.name || 'your property');
  const payoutAmount = Number(payoutInfo.amount || 0).toFixed(2);
  const isCancellation = payoutInfo.kind === 'cancellation' || booking.manualPayoutKind === 'cancellation';
  const nights = Number(booking.nights) || 1;
  const roomTotal = Number(booking.base || payoutInfo.amount || 0).toFixed(2);
  const ref = e(payoutInfo.reference || `KDH-${booking.id}`);
  const paidAtIso = payoutInfo.paidAt || new Date().toISOString();

  const paidAt = (() => {
    try {
      return new Date(paidAtIso).toLocaleString('en-MY', {
        timeZone: 'Asia/Kuala_Lumpur',
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true
      }) + ' MYT';
    } catch (_) { return e(paidAtIso); }
  })();

  const acct = String(homestay.ownerBankAccount || '').replace(/[^0-9]/g, '');
  const bankMasked = acct.length >= 4 ? '****' + acct.slice(-4) : 'N/A';
  const bankName = e(homestay.ownerBank || 'Bank');

  const methodLabel = isManual
    ? 'Bank transfer (manual)'
    : (isSimulation ? 'Simulated (test)' : 'CHIP Send');

  const testBanner = isSimulation ? `
    <div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:12px;padding:16px;margin-bottom:20px;text-align:center;">
      <div style="font-size:13px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:1.5px;">&#9888;&#65039; Test Email — Simulated Payout</div>
      <div style="font-size:12px;color:#78350f;margin-top:6px;line-height:1.5;">
        This statement was generated in <strong>simulation mode</strong>.<br>
        No real money was transferred to any bank account.
      </div>
    </div>
  ` : '';

  const headerSubtitle = isSimulation ? 'Payout Statement — TEST' : 'Payout Statement';

  const rawReceiptUrl = safeUrl(payoutInfo.receiptUrl);
  const showReceipt = rawReceiptUrl && !isSimulation;
  const emailReceiptUrl = showReceipt ? safeUrl(cloudinaryEmailUrl(rawReceiptUrl)) : '';

  const receiptBlock = showReceipt ? `
    <div style="margin-top:28px;padding-top:20px;border-top:1px dashed #d1d5db;">
      <div style="font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;text-align:center;">Bank Transfer Receipt (Proof of Payment)</div>
      <a href="${escAttr(rawReceiptUrl)}" target="_blank" rel="noopener" style="text-decoration:none;display:block;">
        <img src="${escAttr(emailReceiptUrl)}" alt="Bank Transfer Receipt" style="display:block;width:100%;max-width:480px;height:auto;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff;margin:0 auto;" />
      </a>
      <div style="text-align:center;margin-top:16px;">
        <a href="${escAttr(rawReceiptUrl)}" target="_blank" rel="noopener" style="display:inline-block;background:#0F382E;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 26px;border-radius:8px;letter-spacing:0.3px;">View Full-Size Receipt &rarr;</a>
      </div>
    </div>
  ` : '';

  const supportWhatsappNumber = String(env?.SUPPORT_WHATSAPP || '').replace(/[^0-9]/g, '');
  const whatsappMsg = `Hi, I'm ${homestay.ownerName || 'Host'} from ${homestay.name || 'your property'}. I have a question about my payout of RM ${payoutAmount} (Ref: ${payoutInfo.reference || `KDH-${booking.id}`}).`;
  const supportWhatsappBlock = supportWhatsappNumber && !isSimulation
    ? `<div style="text-align:center;margin-top:24px;">
         <a href="https://wa.me/${supportWhatsappNumber}?text=${encodeURIComponent(whatsappMsg)}"
            style="display:inline-block;background:#25D366;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 26px;border-radius:8px;letter-spacing:0.3px;">
           &#128172; Chat with us on WhatsApp
         </a>
       </div>`
    : '';

  const cancelTypeForPayout = String(
    payoutInfo.cancelType || booking.cancel_type || ''
  ).toLowerCase();
  const noteStyle = 'color:#6b7280;font-size:12.5px;line-height:1.6;margin-top:6px;';
  let cancellationNoteHtml = '';
  if (cancelTypeForPayout === 'no_show') {
    cancellationNoteHtml = `<p style="${noteStyle}">The guest did not arrive and did not make contact within 24 hours of the arrival date. The room was held for them and could not be resold, so under our published policy the room price is yours.</p>`;
  } else if (cancelTypeForPayout === 'emergency_no_show') {
    cancellationNoteHtml = `<p style="${noteStyle}">The guest did not arrive, and we approved their emergency. Under our published policy a no-show with an approved emergency settles at half the room price for each side. This is your half.</p>`;
  } else if (cancelTypeForPayout === 'platform') {
    cancellationNoteHtml = `<p style="${noteStyle}">We cancelled this booking ourselves, for reasons outside anyone's control. The guest was refunded in full and no payout is due to you for this booking.</p>`;
  } else if (isCancellation) {
    cancellationNoteHtml = `<p style="${noteStyle}">The guest cancelled after the room was held for them and could no longer be resold. Under our published policy, this is your share of the room price for that booking.</p>`;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f5f0;padding:20px;">
      <div style="background:#ffffff;padding:30px;border-radius:16px;border:1px solid #e5e7eb;">
        ${testBanner}
        <div style="text-align:center;border-bottom:2px solid #0F382E;padding-bottom:16px;margin-bottom:22px;">
          <div style="font-size:22px;font-weight:800;color:#0F382E;">Kundasang Homestay</div>
          <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;margin-top:4px;">${headerSubtitle}</div>
        </div>
        <h2 style="color:#0F382E;margin-top:0;font-size:18px;">Hello ${ownerName},</h2>
                <p style="color:#4b5563;font-size:14px;line-height:1.6;">
          ${isCancellation
            ? `A payout for a <strong>cancelled booking</strong> at <strong>${homestayName}</strong> has been ${isSimulation ? 'simulated (test)' : 'sent to your bank account'}.`
            : `A payout for a completed guest stay at <strong>${homestayName}</strong> has been ${isSimulation ? 'simulated (test)' : 'sent to your bank account'}.`}
        </p>
        ${cancellationNoteHtml}
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:22px 0;text-align:center;">
          <div style="font-size:11px;color:#166534;text-transform:uppercase;letter-spacing:1px;font-weight:700;">${isSimulation ? 'Amount (simulated)' : 'Amount Transferred'}</div>
          <div style="font-size:32px;font-weight:800;color:#0F382E;margin:6px 0;">RM ${payoutAmount}</div>
          <div style="font-size:12px;color:#166534;">${isSimulation ? 'Simulated payout — no funds moved' : `To ${bankName} ${bankMasked}`}</div>
        </div>
        <table style="width:100%;font-size:14px;border-collapse:collapse;margin:24px 0;color:#374151;">
          <tr><td style="padding:10px 0;color:#6b7280;">Room price (${nights} night${nights === 1 ? '' : 's'})</td><td style="padding:10px 0;text-align:right;">RM ${roomTotal}</td></tr>
          <tr><td colspan="2" style="border-top:1px solid #e5e7eb;padding:0;"></td></tr>
          <tr><td style="padding:14px 0 0 0;font-weight:700;color:#0F382E;font-size:15px;">Net amount transferred to you</td><td style="padding:14px 0 0 0;text-align:right;font-weight:800;color:#0F382E;font-size:17px;">RM ${payoutAmount}</td></tr>
        </table>
        <div style="font-size:12px;color:#4b5563;margin-bottom:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Payout Details</div>
        <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:20px;color:#374151;">
          <tr><td style="padding:6px 0;color:#6b7280;">Reference</td><td style="padding:6px 0;text-align:right;font-family:'Courier New',monospace;font-weight:700;">${ref}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Method</td><td style="padding:6px 0;text-align:right;">${methodLabel}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Date</td><td style="padding:6px 0;text-align:right;">${paidAt}</td></tr>
        </table>
        <div style="font-size:12px;color:#4b5563;margin-bottom:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Booking Details</div>
        <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:20px;color:#374151;">
          <tr><td style="padding:6px 0;color:#6b7280;">Booking ID</td><td style="padding:6px 0;text-align:right;font-family:'Courier New',monospace;">${e(booking.id)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Guest</td><td style="padding:6px 0;text-align:right;">${e(booking.guestName) || 'Guest'}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Check-in</td><td style="padding:6px 0;text-align:right;">${e(booking.checkin)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;">Check-out</td><td style="padding:6px 0;text-align:right;">${e(booking.checkout)}</td></tr>
        </table>
        ${receiptBlock}
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;font-size:12px;color:#475569;line-height:1.6;margin-top:20px;">
          If you don't see this amount in your bank account within 1 business day, please reply to this email or contact us at <a href="mailto:support@kundasanghomestay.my" style="color:#0F382E;font-weight:600;">support@kundasanghomestay.my</a> quoting the reference number above.
        </div>
        ${supportWhatsappBlock}
        <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px;margin-bottom:0;">
          &copy; ${new Date().getFullYear()} Kundasang Homestay
        </p>
      </div>
    </div>
  `;

  const subject = isSimulation
    ? `[TEST] Payout Statement — RM ${payoutAmount} for Booking ${String(booking.id||'').replace(/[\r\n]+/g,'')}`
    : `Payout Statement — RM ${payoutAmount} for Booking ${String(booking.id||'').replace(/[\r\n]+/g,'')}`;

  return sendEmail({
    to: homestay.ownerEmail,
    subject,
    html
  }, env);
}

// ============================================================
// Payout record email (for the Google Apps Script filing pipeline)
// ============================================================

export async function sendPayoutRecordEmail(booking, payoutInfo, env) {
  const to = env.PAYOUT_RECORDS_EMAIL || 'support@kundasanghomestay.my';
  const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const amount = Number(payoutInfo.amount || 0).toFixed(2);
  const hostName = clean(payoutInfo.hostName || 'Host');

  const subject = `[PAYOUT-RECORD] ${clean(booking.id)} - RM${amount} - ${hostName}`;

  // Field-per-line format the Apps Script parses. Do not reformat
  // without also updating the parser.
  const lines = [
    `Booking ID: ${clean(booking.id)}`,
    `Host: ${hostName}`,
    `Host Email: ${clean(payoutInfo.hostEmail)}`,
    `Host WhatsApp: ${clean(payoutInfo.hostWhatsapp)}`,
    `Homestay: ${clean(payoutInfo.homestayName)}`,
    `Guest: ${clean(booking.guestName)}`,
    `Check-in: ${clean(booking.checkin)}`,
    `Check-out: ${clean(booking.checkout)}`,
    `Amount: ${amount}`,
    `Payout Date: ${clean(payoutInfo.paidAt || new Date().toISOString())}`,
    `Method: ${clean(payoutInfo.method || 'manual_transfer')}`,
    `Bank Ref: ${clean(payoutInfo.reference)}`,
    `Receipt: ${clean(payoutInfo.receiptUrl)}`
  ];
  const textBody = lines.join('\n');

  const htmlBody =
    '<div style="font-family:monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;">' +
    lines.map(l => escHtml(l)).join('<br>\n') +
    '</div>';

  return sendEmail({
    to,
    subject,
    html: htmlBody,
    text: textBody
  }, env);
}

// ============================================================
// CHIP Send — 4-step flow
// (Unchanged from the previous revision except for the defensive
// amount check and the audit-logging parameter that was previously
// accepted but never used.)
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
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
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
