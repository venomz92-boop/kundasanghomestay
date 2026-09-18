// /functions/api/lib/session.js
// Session management for guests, owners, and admins

import { verifySignedToken } from './crypto.js';
import { getCookie, getBearerToken } from './http.js';
import { getUserRecord, getOwnerMaxSessionVersion } from './database.js';

/**
 * Get guest session from request
 * @param {Request} request 
 * @param {Object} env 
 * @returns {Promise<Object|null>}
 */
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

/**
 * Get owner session from request
 * @param {Request} request 
 * @param {Object} env 
 * @returns {Promise<Object|null>}
 */
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

/**
 * Get admin session from request
 * @param {Request} request 
 * @param {Object} env 
 * @returns {Promise<Object|null>}
 */
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

/**
 * Verify admin authentication
 * @param {Request} request 
 * @param {Object} env 
 * @returns {Promise<boolean>}
 */
export async function verifyAdminAuth(request, env) {
  const session = await getAdminSession(request, env);
  return !!session;
}
