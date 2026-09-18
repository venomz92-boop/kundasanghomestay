// /functions/api/lib/database.js
// Database utilities: rate limiting, audit logging, session management

import { cleanWhatsapp } from './validation.js';

/**
 * Get user record from database
 * @param {'guest'|'owner'} type 
 * @param {string} userId 
 * @param {Object} db 
 * @returns {Promise<Object|null>}
 */
async function getUserRecord(type, userId, db) {
  if (type === 'guest') {
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch(_) {}
    return guests.find(g => String(g.id) === String(userId)) || null;
  } else if (type === 'owner') {
    const key = String(userId || '');
    const cleanWa = cleanWhatsapp(key);

    const ownersRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
    let owners = [];
    try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch(_) {}
    const ownerAccount = owners.find(o =>
      String(o.id) === key ||
      (cleanWa && cleanWhatsapp(o.whatsapp || '') === cleanWa)
    );
    if (ownerAccount) return ownerAccount;

    const approved = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
    const pending = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
    let homes = [];
    try { if (approved?.data) homes = homes.concat(JSON.parse(approved.data)); } catch(_) {}
    try { if (pending?.data) homes = homes.concat(JSON.parse(pending.data)); } catch(_) {}
    return homes.find(h =>
      String(h.id) === key ||
      (cleanWa && cleanWhatsapp(h.whatsapp || '') === cleanWa)
    ) || null;
  }
  return null;
}

/**
 * Get maximum owner session version
 * @param {Object} db 
 * @param {string} ownerIdOrWhatsapp 
 * @returns {Promise<{found: boolean, maxVersion: number}>}
 */
async function getOwnerMaxSessionVersion(db, ownerIdOrWhatsapp) {
  const key = String(ownerIdOrWhatsapp || '').trim();
  const cleanWa = cleanWhatsapp(key);
  let maxVersion = 0;
  let found = false;

  const ownersRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
  let owners = [];
  try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch(_) {}
  for (const o of owners) {
    const matches = String(o.id) === key ||
      (cleanWa && cleanWhatsapp(o.whatsapp || '') === cleanWa);
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
      (cleanWa && cleanWhatsapp(h.whatsapp || '') === cleanWa);
    if (matches) {
      found = true;
      const v = Number(h.ownerSessionVersion || 0);
      if (v > maxVersion) maxVersion = v;
    }
  }

  return { found, maxVersion };
}

/**
 * Ensure rate limits table exists
 * @param {Object} db 
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
 * Check rate limit for IP/action
 * @param {Object} db 
 * @param {string} ip 
 * @param {string} action 
 * @param {number} maxAttempts 
 * @param {number} windowSeconds 
 * @returns {Promise<boolean>}
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
    return true;
  }
}

/**
 * Record rate limit hit
 * @param {Object} db 
 * @param {string} ip 
 * @param {string} action 
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
    // silent
  }
}

/**
 * Log action to audit log
 * @param {Object} options 
 * @param {Object} options.db 
 * @param {string} options.action 
 * @param {string} options.admin 
 * @param {string} options.details 
 * @param {string} options.ip 
 * @param {string} options.userId 
 * @param {string} options.homestayId 
 * @returns {Promise<boolean>}
 */
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

/**
 * Increment guest or owner session version
 * @param {Object} db 
 * @param {string} userId 
 * @param {'guest'|'owner'} type 
 * @returns {Promise<boolean>}
 */
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

/**
 * Increment owner session version by ID or whatsapp
 * @param {Object} db 
 * @param {string} ownerIdOrWhatsapp 
 * @returns {Promise<boolean>}
 */
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
    let records = [];
    try { records = JSON.parse(r.data); } catch (_) { continue; }
    let listChanged = false;
    records = records.map(h => {
      const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
      if (hWa === whatsapp) {
        listChanged = true;
        changed = true;
        h.ownerSessionVersion = (h.ownerSessionVersion || 0) + 1;
      }
      return h;
    });
    if (listChanged) {
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind(key, JSON.stringify(records)).run();
    }
  }

  return changed;
}

/**
 * Get owner's homestay IDs from database
 * @param {Object} db 
 * @param {Object|string} ownerOrWhatsapp 
 * @returns {Promise<Array<string>>}
 */
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

/**
 * Record check-in attempt
 * @param {Object} db 
 * @param {string} bookingId 
 */
export async function recordCheckinAttempt(db, bookingId) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS checkin_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )`).run();
    await db.prepare(
      `INSERT INTO checkin_attempts (booking_id, timestamp) VALUES (?, ?)`
    ).bind(bookingId, Date.now()).run();
  } catch (_) {}
}

/**
 * Get recent check-in attempts
 * @param {Object} db 
 * @param {string} bookingId 
 * @param {number} windowMs 
 * @returns {Promise<Array>}
 */
export async function getRecentCheckinAttempts(db, bookingId, windowMs = 3600000) {
  try {
    const cutoff = Date.now() - windowMs;
    const res = await db.prepare(
      `SELECT * FROM checkin_attempts WHERE booking_id = ? AND timestamp > ? ORDER BY timestamp DESC`
    ).bind(bookingId, cutoff).all();
    return res?.results || [];
  } catch (_) {
    return [];
  }
}

/**
 * Clear check-in attempts for booking
 * @param {Object} db 
 * @param {string} bookingId 
 */
export async function clearCheckinAttempts(db, bookingId) {
  try {
    await db.prepare(`DELETE FROM checkin_attempts WHERE booking_id = ?`).bind(bookingId).run();
  } catch (_) {}
}

/**
 * Invalidate owner sessions for a homestay
 * @param {Object} db 
 * @param {string} homestayId 
 */
export async function invalidateOwnerSessionsForHomestay(db, homestayId) {
  // Implementation depends on your session invalidation strategy
  // This is a placeholder for future implementation
}

/**
 * Invalidate owner sessions for an owner
 * @param {Object} db 
 * @param {string} ownerIdOrWhatsapp 
 */
export async function invalidateOwnerSessionsForOwner(db, ownerIdOrWhatsapp) {
  await incrementOwnerSessionVersion(db, ownerIdOrWhatsapp);
}

/**
 * Invalidate owner sessions (wrapper)
 * @param {Object} db 
 * @param {string} homestayId 
 */
export async function invalidateOwnerSessions(db, homestayId) {
  await invalidateOwnerSessionsForHomestay(db, homestayId);
}

/**
 * Acquire distributed lock
 * @param {Object} db 
 * @param {string} lockKey 
 * @param {Function} callback 
 * @param {number} staleTimeoutMs 
 * @returns {Promise<any>}
 */
export async function withLock(db, lockKey, callback, staleTimeoutMs = 5000) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS locks (
      key TEXT PRIMARY KEY,
      acquired_at INTEGER NOT NULL
    )`).run();

    const now = Date.now();
    const staleCutoff = now - staleTimeoutMs;

    // Try to release any stale lock first
    await db.prepare(`DELETE FROM locks WHERE acquired_at < ?`).bind(staleCutoff).run();

    // Try to acquire
    try {
      await db.prepare(`INSERT INTO locks (key, acquired_at) VALUES (?, ?)`)
        .bind(lockKey, now).run();
    } catch (e) {
      // Lock already held
      return null;
    }

    try {
      return await callback();
    } finally {
      // Release lock
      await db.prepare(`DELETE FROM locks WHERE key = ?`).bind(lockKey).run();
    }
  } catch (e) {
    return null;
  }
}
