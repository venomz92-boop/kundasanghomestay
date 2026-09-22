// /api/owner-login.js — Plain English: host login.
//
// [THIS REVISION]
// The dummy record used for timing-equalisation now matches the real
// iteration count. Before this change the dummy used 600,000 iterations
// while real records used 100,000 — an attacker could tell whether a
// WhatsApp number existed by measuring response time. The dummy is now
// built at request time from the same PBKDF2_ITERATIONS value real
// records use.
//
// [SESSION COLLISION FIX]
// When an owner logs in, the `guest_token` cookie is now explicitly
// cleared in the response. This prevents the same class of session-
// collision leak that was fixed in login.js and admin-login.js: a
// browser that had a guest session and then logs in as an owner would
// hold BOTH cookies. Clearing the guest cookie on owner login removes
// the ambiguity: one browser, one identity.
import {
  corsHeaders, getClientIP, enforceHttps, verifyPassword, hashPassword,
  createSignedToken, cookieHeader, clearCookieHeader, jsonResponse, checkRateLimit,
  recordRateLimit, parseJSONSafely
} from './_utils.js';

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
    const rateOk = await checkRateLimit(db, clientIP, 'owner_login', 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }

    const body = await parseJSONSafely(request);
    const { whatsapp, password } = body;
    const cleanWhatsapp = String(whatsapp || '').replace(/[^0-9]/g, '');
    const cleanPassword = String(password || '');
    if (!cleanWhatsapp || cleanPassword.length < 1) {
      await recordRateLimit(db, clientIP, 'owner_login');
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
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    // ---- Migrate legacy password to PBKDF2 across ALL matching records ----
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
      passwordVersion: (ownerAccount && ownerAccount.ownerPasswordVersion)
        || (ownerHomesWithPassword[0] && ownerHomesWithPassword[0].ownerPasswordVersion)
        || 1,
      ownerSessionVersion
    }, env);

    const safeHomes = ownerHomes.map(({
      ownerPasswordHash, ownerSalt, ownerPasswordAlgorithm,
      ownerPasswordVersion, ownerSessionVersion: _sv, ...rest
    }) => rest);

    // Build headers with TWO Set-Cookie directives:
    //   1. Set the new owner_token.
    //   2. Clear the guest_token so this browser is unambiguously
    //      an owner session, not a guest session. Prevents the
    //      session-collision leak.
    const headers = new Headers(corsHeaders(request, env));
    headers.append('Set-Cookie', cookieHeader('owner_token', token));
    headers.append('Set-Cookie', clearCookieHeader('guest_token'));

    return new Response(JSON.stringify({
      success: true,
      homestays: safeHomes,
      message: 'Login successful'
    }), {
      status: 200,
      headers
    });
  } catch (e) {
    console.error('Owner login error:', e.message, e.stack);
    return jsonResponse({ error: 'Server error. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}
