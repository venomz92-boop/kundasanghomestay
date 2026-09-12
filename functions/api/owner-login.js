// /api/owner-login.js — Plain English: host login. Two fixes:
// (1) The session token is NO LONGER returned in the JSON body (it lives
//     only in the HttpOnly cookie).
// (2) A host whose account exists in kd_owners but who has not yet
//     submitted a property can now log in. We look up the phone number in
//     BOTH kd_owners AND kd_approved/kd_pending. If both exist we prefer
//     kd_owners (the newer flow). homestayIds may legitimately be empty.
//
// [THIS REVISION]
// (3) The filter that decides which homestays belong to this WhatsApp no
//     longer requires `ownerPasswordHash` and `ownerSalt`. Those fields
//     are stripped from a listing when it is approved, so the old filter
//     excluded every approved listing from the login response's
//     `homestays` array — the owner would log in and see an empty
//     dropdown until they refreshed the page.
//     Auth still uses password fields; the "homestays list" is now
//     decoupled from the auth path.
import {
  corsHeaders, getClientIP, enforceHttps, verifyPassword, hashPassword,
  createSignedToken, cookieHeader, jsonResponse, checkRateLimit,
  recordRateLimit, parseJSONSafely
} from './_utils.js';

// Dummy record for timing equalization on unknown WhatsApp numbers.
// Keep the algorithm string in sync with PBKDF2_ITERATIONS in _utils.js.
const DUMMY_OWNER_RECORD = {
  ownerPasswordHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ownerSalt: 'AAAAAAAAAAAAAAAAAAAAAA',
  ownerPasswordAlgorithm: 'PBKDF2-600000-SHA256'
};

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

    // ============================================================
    // Look up in BOTH kd_owners AND kd_approved/kd_pending.
    // ============================================================
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

    // All homestays belonging to this WhatsApp — approved or pending.
    // No password requirement on this list; it's just ownership.
    const ownerHomes = homes.filter(h =>
      String(h.whatsapp || '').replace(/[^0-9]/g, '') === cleanWhatsapp
    );

    // Auth path: only these need to carry password fields.
    const ownerHomesWithPassword = ownerHomes.filter(h =>
      h.ownerPasswordHash && h.ownerSalt
    );

    const accountHasPassword = !!(ownerAccount && ownerAccount.ownerPasswordHash && ownerAccount.ownerSalt);
    const homestayHasPassword = ownerHomesWithPassword.length > 0;

    // If neither source has a password, we cannot authenticate this user.
    if (!accountHasPassword && !homestayHasPassword) {
      // Run dummy PBKDF2 to keep timing constant regardless of existence.
      await verifyPassword(cleanPassword, DUMMY_OWNER_RECORD, env);
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

    // ---- homestayIds now includes approved AND pending listings ----
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

    // Strip password fields from every homestay we return.
    const safeHomes = ownerHomes.map(({
      ownerPasswordHash, ownerSalt, ownerPasswordAlgorithm,
      ownerPasswordVersion, ownerSessionVersion: _sv, ...rest
    }) => rest);

    return new Response(JSON.stringify({
      success: true,
      homestays: safeHomes,
      message: 'Login successful'
    }), {
      status: 200,
      headers: {
        ...corsHeaders(request),
        'Set-Cookie': cookieHeader('owner_token', token)
      }
    });
  } catch (e) {
    console.error('Owner login error:', e.message, e.stack);
    return jsonResponse({ error: 'Server error. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
