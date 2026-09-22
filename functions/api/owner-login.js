// /api/owner-login.js — Plain English: host login.
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - Owner login now clears admin_token (was only clearing guest_token).
//   This closes the same session-collision class of bug that
//   guest-login.js and admin-login.js were already patched for: a
//   browser that had an admin session and then logged in as an owner
//   held BOTH cookies, and if the owner session check ever failed on
//   /api/bookings the request could fall through to the admin branch
//   and expose admin data on an owner page.
// - Added a global owner-login rate limit in parallel with the per-IP
//   one, so a distributed brute force across many IPs is slowed.
// - passwordVersion default uses ?? instead of || so a legitimate
//   version of 0 is preserved.
// - Success response is now Cache-Control: no-store.
// - Error log no longer includes the stack trace.
//
// NOT changed here:
// - Owner session TTL is still 24h (matches cookieHeader default).
//   Guest sessions are 30 days. If hosts complain about being logged
//   out every day, raise this deliberately — do not silently extend it.
// - Legacy-migration path still runs on successful login when the
//   stored hash is legacy SHA-256 (see comment below).
import {
  corsHeaders, getClientIP, enforceHttps, verifyPassword, hashPassword,
  createSignedToken, cookieHeader, clearCookieHeader, jsonResponse, checkRateLimit,
  recordRateLimit, parseJSONSafely
} from './_utils.js';

const OWNER_TTL_MS      = 24 * 60 * 60 * 1000; // 24 hours (existing behavior)
const OWNER_TTL_SECONDS = OWNER_TTL_MS / 1000;

// Per-IP limits
const IP_LIMIT = 5;
const IP_WINDOW_SECONDS = 15 * 60;
// Global limit — fixed sentinel, not an IP address.
const GLOBAL_KEY = '__owner_login_global__';
const GLOBAL_LIMIT = 60;
const GLOBAL_WINDOW_SECONDS = 15 * 60;

const DUMMY_PASSWORD = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';

function makeDummyRecord(env) {
  const parsed = parseInt(env && env.PBKDF2_ITERATIONS, 10);
  const iterations = (Number.isFinite(parsed) && parsed >= 10000) ? parsed : 100000;
  return {
    ownerPasswordHash: DUMMY_PASSWORD,
    ownerSalt: DUMMY_SALT,
    ownerPasswordAlgorithm: `PBKDF2-${iterations}-SHA256`
  };
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // Per-IP limit
    const ipOk = await checkRateLimit(db, clientIP, 'owner_login', IP_LIMIT, IP_WINDOW_SECONDS);
    if (!ipOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }
    // Global limit
    const globalOk = await checkRateLimit(db, GLOBAL_KEY, 'owner_login', GLOBAL_LIMIT, GLOBAL_WINDOW_SECONDS);
    if (!globalOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }

    const body = await parseJSONSafely(request);
    const { whatsapp, password } = body;
    const cleanWhatsapp = String(whatsapp || '').replace(/[^0-9]/g, '');
    const cleanPassword = String(password || '');
    if (!cleanWhatsapp || cleanPassword.length < 1) {
      await recordRateLimit(db, clientIP, 'owner_login');
      await recordRateLimit(db, GLOBAL_KEY, 'owner_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const ownersRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_owners').first();
    let owners = [];
    try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch(_) {}

    const a = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
    const p = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_pending').first();
    let homes = [];
    try { if (a?.data) homes = JSON.parse(a.data); } catch(_) {}
    try { if (p?.data) homes = homes.concat(JSON.parse(p.data)); } catch(_) {}

    const ownerAccount = owners.find(o =>
      String(o.whatsapp || '').replace(/[^0-9]/g, '') === cleanWhatsapp
    ) || null;

    const ownerHomes = homes.filter(h =>
      String(h.whatsapp || '').replace(/[^0-9]/g, '') === cleanWhatsapp
    );

    const ownerHomesWithPassword = ownerHomes.filter(h =>
      h.ownerPasswordHash && h.ownerSalt
    );

    const accountHasPassword = !!(ownerAccount && ownerAccount.ownerPasswordHash && ownerAccount.ownerSalt);
    const homestayHasPassword = ownerHomesWithPassword.length > 0;

    if (!accountHasPassword && !homestayHasPassword) {
      // Run dummy PBKDF2 to keep timing constant regardless of existence.
      await verifyPassword(cleanPassword, makeDummyRecord(env), env);
      await recordRateLimit(db, clientIP, 'owner_login');
      await recordRateLimit(db, GLOBAL_KEY, 'owner_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const recordToCheck = accountHasPassword
      ? {
          ownerPasswordHash: ownerAccount.ownerPasswordHash,
          ownerSalt: ownerAccount.ownerSalt,
          ownerPasswordAlgorithm: ownerAccount.ownerPasswordAlgorithm
        }
      : {
          ownerPasswordHash: ownerHomesWithPassword[0].ownerPasswordHash,
          ownerSalt: ownerHomesWithPassword[0].ownerSalt,
          ownerPasswordAlgorithm: ownerHomesWithPassword[0].ownerPasswordAlgorithm
        };

    const checked = await verifyPassword(cleanPassword, recordToCheck, env);
    if (!checked.ok) {
      await recordRateLimit(db, clientIP, 'owner_login');
      await recordRateLimit(db, GLOBAL_KEY, 'owner_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    // ---- Migrate legacy password to PBKDF2 across ALL matching records ----
    // This is a hash-format upgrade, not a password change, so we do
    // NOT bump ownerSessionVersion — existing sessions stay valid.
    if (checked.legacy) {
      const fresh = await hashPassword(cleanPassword, env);
      const versionBump = (rec) => (Number(rec.ownerPasswordVersion) || 0) + 1;

      if (accountHasPassword) {
        owners = owners.map(o => {
          const oWa = String(o.whatsapp || '').replace(/[^0-9]/g, '');
          if (oWa !== cleanWhatsapp) return o;
          return {
            ...o,
            ownerPasswordHash: fresh.hash,
            ownerSalt: fresh.salt,
            ownerPasswordAlgorithm: fresh.algorithm,
            ownerPasswordVersion: versionBump(o)
          };
        });
        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_owners', JSON.stringify(owners)).run();
      }

      for (const keyName of ['kd_approved', 'kd_pending']) {
        const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind(keyName).first();
        let arr = [];
        try { if (rr?.data) arr = JSON.parse(rr.data); } catch(_) {}
        let changed = false;
        arr = arr.map(h => {
          const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
          if (hWa !== cleanWhatsapp) return h;
          changed = true;
          return {
            ...h,
            ownerPasswordHash: fresh.hash,
            ownerSalt: fresh.salt,
            ownerPasswordAlgorithm: fresh.algorithm,
            ownerPasswordVersion: versionBump(h)
          };
        });
        if (changed) {
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind(keyName, JSON.stringify(arr)).run();
        }
      }
    }

    const homestayIds = ownerHomes.map(h => h.id);

    const ownerId = ownerAccount
      ? String(ownerAccount.id)
      : (ownerHomes[0] ? String(ownerHomes[0].id) : `O-${cleanWhatsapp}`);

    const ownerName = ownerAccount
      ? ownerAccount.ownerName
      : (ownerHomes[0] ? ownerHomes[0].ownerName : null);

    const versionPool = [];
    if (ownerAccount) versionPool.push(Number(ownerAccount.ownerSessionVersion) || 0);
    for (const h of ownerHomes) versionPool.push(Number(h.ownerSessionVersion) || 0);
    const ownerSessionVersion = versionPool.length > 0 ? Math.max(...versionPool) : 0;

    const token = await createSignedToken({
      type: 'owner',
      ownerId,
      homestayIds,
      ownerName,
      whatsapp: cleanWhatsapp,
      passwordVersion: Number(
        (ownerAccount && ownerAccount.ownerPasswordVersion)
        ?? (ownerHomesWithPassword[0] && ownerHomesWithPassword[0].ownerPasswordVersion)
        ?? 1
      ),
      ownerSessionVersion
    }, env, OWNER_TTL_MS);

    const safeHomes = ownerHomes.map(({
      ownerPasswordHash, ownerSalt, ownerPasswordAlgorithm,
      ownerPasswordVersion, ownerSessionVersion: _sv, ...rest
    }) => rest);

    // Three Set-Cookie directives:
    //   1. Set the new owner_token.
    //   2. Clear guest_token (owner + guest coexistence ambiguity).
    //   3. Clear admin_token (session-collision fix — same class of
    //      bug that guest-login.js and admin-login.js were patched for).
    const headers = new Headers(corsHeaders(request));
    headers.set('Cache-Control', 'no-store');
    headers.append('Set-Cookie', cookieHeader('owner_token', token, OWNER_TTL_SECONDS));
    headers.append('Set-Cookie', clearCookieHeader('guest_token'));
    headers.append('Set-Cookie', clearCookieHeader('admin_token'));

    return new Response(JSON.stringify({
      success: true,
      homestays: safeHomes,
      message: 'Login successful'
    }), {
      status: 200,
      headers
    });
  } catch (e) {
    console.error('Owner login error:', e.message);
    return jsonResponse({ error: 'Server error. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
