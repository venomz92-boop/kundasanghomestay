// /functions/api/lib/crypto.js
// Cryptographic utilities for authentication and security

const DEFAULT_PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH = 'SHA-256';
const PBKDF2_KEYLEN = 256;

/**
 * Get PBKDF2 iterations from environment or use default
 * @param {Object} env - Environment variables
 * @returns {number} Number of iterations
 */
export function getPbkdf2Iterations(env) {
  const fromEnv = env?.PBKDF2_ITERATIONS;
  const parsed = parseInt(fromEnv, 10);
  if (Number.isFinite(parsed) && parsed >= 10000 && parsed <= 2000000) {
    return parsed;
  }
  return DEFAULT_PBKDF2_ITERATIONS;
}

/**
 * Base64url encode input (string or Uint8Array)
 * @param {string|Uint8Array} input 
 * @returns {string}
 */
export function b64urlEncode(input) {
  let bytes;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else bytes = input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Base64url decode to Uint8Array
 * @param {string} value 
 * @returns {Uint8Array}
 */
export function b64urlDecodeToBytes(value) {
  const s = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

/**
 * Base64url decode to string
 * @param {string} value 
 * @returns {string}
 */
export function b64urlDecode(value) {
  return new TextDecoder().decode(b64urlDecodeToBytes(value));
}

/**
 * Create HMAC signature
 * @param {string} value 
 * @param {string} secret 
 * @returns {Promise<string>}
 */
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

/**
 * Verify HMAC signature
 * @param {string} value 
 * @param {string} signature 
 * @param {string} secret 
 * @returns {Promise<boolean>}
 */
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

/**
 * Validate SESSION_SECRET exists and meets minimum requirements
 * @param {Object} env 
 * @returns {string}
 * @throws {Error}
 */
export function requireSessionSecret(env) {
  const secret = env?.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET is missing or too short');
  }
  return secret;
}

/**
 * Create a signed JWT-like token
 * @param {Object} payload 
 * @param {Object} env 
 * @param {number} ttlMs - Time to live in milliseconds
 * @returns {Promise<string>}
 */
export async function createSignedToken(payload, env, ttlMs = 24 * 60 * 60 * 1000) {
  const secret = requireSessionSecret(env);
  const body = { ...payload, iat: Date.now(), exp: Date.now() + ttlMs };
  const encoded = b64urlEncode(JSON.stringify(body));
  const signature = await hmacSign(encoded, secret);
  return `${encoded}.${signature}`;
}

/**
 * Create admin token with 8-hour TTL
 * @param {Object} payload 
 * @param {Object} env 
 * @returns {Promise<string>}
 */
export async function createAdminToken(payload, env) {
  return createSignedToken(payload, env, 8 * 60 * 60 * 1000);
}

/**
 * Verify and decode a signed token
 * @param {string} token 
 * @param {Object} env 
 * @returns {Promise<Object|null>}
 */
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

/**
 * Generate random salt
 * @returns {string}
 */
export function generateSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return b64urlEncode(bytes);
}

/**
 * Derive password hash using PBKDF2
 * @param {string} password 
 * @param {string} salt 
 * @param {string} pepper 
 * @param {number} iterations 
 * @returns {Promise<string>}
 */
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

/**
 * Hash password with salt and pepper
 * @param {string} password 
 * @param {Object} env 
 * @param {string} salt 
 * @returns {Promise<Object>}
 */
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

/**
 * Compute SHA256 hash
 * @param {string} message 
 * @returns {Promise<string>}
 */
export async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify password against stored hash
 * @param {string} password 
 * @param {Object} record 
 * @param {Object} env 
 * @returns {Promise<{ok: boolean, legacy: boolean}>}
 */
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
