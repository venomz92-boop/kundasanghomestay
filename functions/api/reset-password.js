// /api/reset-password.js
//
// [THIS REVISION]
// Added enforceHttps() at the top of onRequestPost, matching every other
// mutating endpoint. The root middleware already forces HTTPS, so this is
// defensive consistency rather than a live fix — but consistency is what
// stops the next bug.
//
// [SECURITY FIX — 2026]
// Added rate limiting to prevent brute-force attacks on password reset tokens.
import { corsHeaders, hashPassword, jsonResponse, invalidateOwnerSessions, enforceHttps, checkRateLimit, recordRateLimit, getClientIP } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);
    
    // Rate limit: 5 attempts per 15 minutes per IP
    const rateOk = await checkRateLimit(db, clientIP, 'reset_password', 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many reset attempts. Please wait 15 minutes.' }, 429, request);
    }

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
      // r.user_id may be an owner account id (O-...) from kd_owners,
      // OR a numeric homestay id from the legacy flow.
      // We resolve it to the owner's whatsapp number, then update
      // every record that shares that whatsapp.
      let whatsapp = null;
      let matched = false;

      // 1) Update kd_owners if this id matches an owner account.
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

      // 2) Update every homestay owned by this person.
      //    Match by id OR by whatsapp (discovered from step 1 or from
      //    the homestay itself for the legacy flow).
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

          // First time we find a matching homestay in the legacy flow,
          // capture its whatsapp so we can sweep siblings and kd_owners.
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

      // 3) If we discovered the whatsapp from a homestay but the owner
      //    also has a kd_owners account, sync the new password there.
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

      // 4) Invalidate every active session for this owner (all their
      //    homestays + their owner account), across all devices.
      if (whatsapp) {
        await invalidateOwnerSessions(db, whatsapp);
      }
    }

    else {
      return jsonResponse({ error: 'Invalid reset link' }, 400, request);
    }

    await db.prepare('UPDATE password_resets SET used=1 WHERE token=?').bind(token).run();
    
    // Record successful reset for rate limiting (prevents enumeration)
    await recordRateLimit(db, clientIP, 'reset_password');
    
    return jsonResponse({ success: true, message: 'Password reset successful. You can now log in.' }, 200, request);
  } catch (e) {
    console.error('Reset password error:', e.message, e.stack);
    return jsonResponse({ error: 'Failed to reset password. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}
