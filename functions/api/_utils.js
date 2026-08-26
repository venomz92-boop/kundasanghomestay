// ===== Add this new function =====
export async function incrementOwnerSessionVersion(db, ownerId) {
  // Increment ownerSessionVersion in both pending and approved lists
  const keys = ['kd_approved', 'kd_pending'];
  let changed = false;
  for (const key of keys) {
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
    let records = [];
    if (r?.data) { try { records = JSON.parse(r.data); } catch(_) {} }
    records = records.map(record => {
      if (String(record.id) === String(ownerId)) {
        changed = true;
        record.ownerSessionVersion = (record.ownerSessionVersion || 0) + 1;
      }
      return record;
    });
    if (changed) {
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind(key, JSON.stringify(records)).run();
    }
  }
  return changed;
}

// ===== Update incrementSessionVersion to handle owners better =====
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

// ===== Update getOwnerSession to verify ownerSessionVersion =====
export async function getOwnerSession(request, env) {
  const token = getBearerToken(request, 'Owner-Authorization') || getCookie(request, 'owner_token');
  if (!token) return null;
  const payload = await verifySignedToken(token, env);
  if (!payload || payload.type !== 'owner') return null;

  const db = env.DB;
  if (!db) return null;
  await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

  // Fetch owner from both approved and pending
  const keys = ['kd_approved', 'kd_pending'];
  let record = null;
  for (const key of keys) {
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
    let records = [];
    if (r?.data) { try { records = JSON.parse(r.data); } catch(_) {} }
    const found = records.find(h => String(h.id) === String(payload.ownerId));
    if (found) { record = found; break; }
  }
  if (!record) return null;

  // Check session version
  if (record.ownerSessionVersion !== undefined && payload.ownerSessionVersion !== undefined) {
    if (Number(record.ownerSessionVersion) !== Number(payload.ownerSessionVersion)) return null;
  }
  // For backward compatibility, if token lacks ownerSessionVersion, we allow it (but token won't have it unless we add it)
  // So we'll add it in owner-login.
  return payload;
}
