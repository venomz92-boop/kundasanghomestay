// /api/audit-log.js
export async function logAction({ db, action, admin, details, ip, userId }) {
  try {
    // Create table if needed
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        action TEXT,
        admin TEXT,
        user_id TEXT,
        details TEXT,
        ip TEXT
      )
    `).run();
    
    await db.prepare(`
      INSERT INTO audit_log (timestamp, action, admin, user_id, details, ip)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      new Date().toISOString(),
      action,
      admin || 'system',
      userId || null,
      details || '',
      ip || 'unknown'
    ).run();
    
    return true;
  } catch(e) {
    console.error('Audit log failed:', e.message);
    return false;
  }
}
