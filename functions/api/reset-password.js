// /api/reset-password.js
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - Uses parseJSONSafely (was request.json) so the 1MB body-size
//   guard applies.
// - Success response is now Cache-Control: no-store.
// - Error log no longer includes the stack trace.
//
// NOT changed (intentional):
// - Guest reset bumps passwordVersion AND sessionVersion → all guest
//   sessions across all devices die immediately.
// - Owner reset calls invalidateOwnerSessions(db, whatsapp), which
//   bumps ownerSessionVersion on the account and every homestay with
//   that whatsapp → all owner sessions across all devices die.
// - Reset token is single-use (used=1 after success).
// - Expiry check uses UTC on both sides (expires_at is stored from
//   toISOString(); compared against SQLite's datetime('now') which is UTC).
//
// TODO (Phase 4): store the reset token hashed rather than plaintext,
// matching how passwords are stored. Requires a one-time purge of
// password_resets first.
import { corsHeaders, hashPassword, jsonResponse, invalidateOwnerSessions, enforceHttps, parseJSONSafely } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    let rawBody;
    try {
      rawBody = await parseJSONSafely(request);
    } catch (_) {
      return jsonResponse({ error: 'Invalid reset request' }, 400, request);
    }

    const { token, password } = rawBody || {};
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

    // ============ GUEST RESET ============
    if (r.user_type === 'guest') {
      const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
      let users = [];
      try { if (rr?.data) users = JSON.parse(rr.data); } catch (_) {}
      const idx = users.findIndex(u => String(u.id) === String(r.user_id));
      if (idx < 0) return jsonResponse({ error: 'Invalid reset link' }, 400, request);
      users[idx].passwordVersion = (users[idx].passwordVersion || 0) + 1;
      users[idx].sessionVersion = (users[idx].sessionVersion || 0) + 1;
      users[idx] = {
        ...users[idx],
        password: hashed.hash,
        salt: hashed.salt,
        passwordAlgorithm: hashed.algorithm,
        passwordUpdated: new Date().toISOString()
      };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_guests', JSON.stringify(users)).run();
    }

    // ============ OWNER RESET ============
    else if (r.user_type === 'owner') {
      let whatsapp = null;
      let matched = false;

      const ownersRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_owners').first();
      let owners = [];
      try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch (_) {}

      const ownerIdx = owners.findIndex(o => String(o.id) === String(r.user_id));
      if (ownerIdx !== -1) {
        whatsapp = String(owners[ownerIdx].whatsapp || '').replace(/[^0-9]/g, '');
        owners[ownerIdx] = {
          ...owners[ownerIdx],
          ownerPasswordHash: hashed.hash,
          ownerSalt: hashed.salt,
          ownerPasswordAlgorithm: hashed.algorithm,
          ownerPasswordVersion: (owners[ownerIdx].ownerPasswordVersion || 0) + 1,
          passwordUpdated: new Date().toISOString()
        };
        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_owners', JSON.stringify(owners)).run();
        matched = true;
      }

      for (const key of ['kd_approved', 'kd_pending']) {
        const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();
        let arr = [];
        try { if (rr?.data) arr = JSON.parse(rr.data); } catch (_) {}
        let updated = false;
        arr = arr.map(h => {
          const hId = String(h.id);
          const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
          const isMatch =
            hId === String(r.user_id) ||
            (whatsapp && hWa === whatsapp);
          if (!isMatch) return h;

          if (!whatsapp && hWa) whatsapp = hWa;
          updated = true;
          matched = true;

          return {
            ...h,
            ownerPasswordHash: hashed.hash,
            ownerSalt: hashed.salt,
            ownerPasswordAlgorithm: hashed.algorithm,
            ownerPasswordVersion: (h.ownerPasswordVersion || 0) + 1,
            passwordUpdated: new Date().toISOString()
          };
        });
        if (updated) {
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind(key, JSON.stringify(arr)).run();
        }
      }

      if (!matched) return jsonResponse({ error: 'Invalid reset link' }, 400, request);

      if (whatsapp && ownerIdx === -1) {
        const ownersSyncIdx = owners.findIndex(
          o => String(o.whatsapp || '').replace(/[^0-9]/g, '') === whatsapp
        );
        if (ownersSyncIdx !== -1) {
          owners[ownersSyncIdx] = {
            ...owners[ownersSyncIdx],
            ownerPasswordHash: hashed.hash,
            ownerSalt: hashed.salt,
            ownerPasswordAlgorithm: hashed.algorithm,
            ownerPasswordVersion: (owners[ownersSyncIdx].ownerPasswordVersion || 0) + 1,
            passwordUpdated: new Date().toISOString()
          };
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_owners', JSON.stringify(owners)).run();
        }
      }

      if (whatsapp) {
        await invalidateOwnerSessions(db, whatsapp);
      }
    }

    else {
      return jsonResponse({ error: 'Invalid reset link' }, 400, request);
    }

    await db.prepare('UPDATE password_resets SET used=1 WHERE token=?').bind(token).run();
    return jsonResponse({ success: true, message: 'Password reset successful. You can now log in.' }, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('Reset password error:', e.message);
    return jsonResponse({ error: 'Failed to reset password. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
