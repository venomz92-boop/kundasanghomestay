import { corsHeaders, hashPassword, jsonResponse } from './_utils.js';

export async function onRequestPost({ request, env }) {
  try {
    const { token, password } = await request.json();
    if (!token || typeof password !== 'string' || password.length < 8) {
      return jsonResponse({ error: 'Invalid reset request' }, 400, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_type TEXT NOT NULL,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0
    )`).run();

    const r = await db.prepare(
      `SELECT * FROM password_resets WHERE token=? AND used=0 AND expires_at>datetime('now')`
    ).bind(token).first();
    if (!r) return jsonResponse({ error: 'Invalid or expired reset link' }, 400, request);

    const hashed = await hashPassword(password, env);

    if (r.user_type === 'guest') {
      const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
      let users = [];
      try { if (rr?.data) users = JSON.parse(rr.data); } catch (_) {}
      const idx = users.findIndex(u => String(u.id) === String(r.user_id));
      if (idx < 0) return jsonResponse({ error: 'Invalid reset link' }, 400, request);
      // Increment password version
      users[idx].passwordVersion = (users[idx].passwordVersion || 0) + 1;
      users[idx] = {
        ...users[idx],
        password: hashed.hash,
        salt: hashed.salt,
        passwordAlgorithm: hashed.algorithm,
        passwordUpdated: new Date().toISOString()
      };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_guests', JSON.stringify(users)).run();
    } else if (r.user_type === 'owner') {
      for (const key of ['kd_approved', 'kd_pending']) {
        const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();
        let arr = [];
        try { if (rr?.data) arr = JSON.parse(rr.data); } catch (_) {}
        let changed = false;
        arr = arr.map(h => {
          if (String(h.id) === String(r.user_id)) {
            changed = true;
            return {
              ...h,
              ownerPasswordHash: hashed.hash,
              ownerSalt: hashed.salt,
              ownerPasswordAlgorithm: hashed.algorithm,
              ownerPasswordVersion: (h.ownerPasswordVersion || 0) + 1,
              passwordUpdated: new Date().toISOString()
            };
          }
          return h;
        });
        if (changed) {
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind(key, JSON.stringify(arr)).run();
        }
      }
    } else {
      return jsonResponse({ error: 'Invalid reset link' }, 400, request);
    }

    await db.prepare('UPDATE password_resets SET used=1 WHERE token=?').bind(token).run();
    return jsonResponse({ success: true, message: 'Password reset successful. You can now log in.' }, 200, request);
  } catch (e) {
    console.error('Reset password error:', e.message, e.stack);
    return jsonResponse({ error: 'Failed to reset password. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
