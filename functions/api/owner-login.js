// /api/owner-login.js
import { corsHeaders, getClientIP, enforceHttps, verifyPassword, hashPassword, createSignedToken, cookieHeader, jsonResponse, checkRateLimit, recordRateLimit, parseJSONSafely } from './_utils.js';

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

    const a = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
    const p = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_pending').first();
    let homes = [];
    try { if (a?.data) homes = JSON.parse(a.data); } catch(_) {}
    try { if (p?.data) homes = homes.concat(JSON.parse(p.data)); } catch(_) {}

    const ownerHomes = homes.filter(h =>
      String(h.whatsapp || '').replace(/[^0-9]/g, '') === cleanWhatsapp &&
      h.ownerPasswordHash && h.ownerSalt
    );
    if (!ownerHomes.length) {
      await recordRateLimit(db, clientIP, 'owner_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const first = ownerHomes[0];
    const checked = await verifyPassword(cleanPassword, {
      ownerPasswordHash: first.ownerPasswordHash,
      ownerSalt: first.ownerSalt,
      ownerPasswordAlgorithm: first.ownerPasswordAlgorithm
    }, env);
    if (!checked.ok) {
      await recordRateLimit(db, clientIP, 'owner_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    // Migrate legacy password
    if (checked.legacy) {
      const fresh = await hashPassword(cleanPassword, env);
      const version = (first.ownerPasswordVersion || 0) + 1;
      for (const h of ownerHomes) {
        h.ownerPasswordHash = fresh.hash;
        h.ownerSalt = fresh.salt;
        h.ownerPasswordAlgorithm = fresh.algorithm;
        h.ownerPasswordVersion = version;
        h.ownerSessionVersion = (h.ownerSessionVersion || 0) + 1;
      }
      for (const keyName of ['kd_approved', 'kd_pending']) {
        const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind(keyName).first();
        let arr = [];
        try { if (rr?.data) arr = JSON.parse(rr.data); } catch(_) {}
        let changed = false;
        arr = arr.map(h => {
          if (ownerHomes.some(o => String(o.id) === String(h.id))) {
            changed = true;
            const updated = ownerHomes.find(o => String(o.id) === String(h.id));
            return { ...h, ...updated };
          }
          return h;
        });
        if (changed) {
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind(keyName, JSON.stringify(arr)).run();
        }
      }
    }

    const homestayIds = ownerHomes.map(h => h.id);
    const ownerSessionVersion = Math.max(...ownerHomes.map(h => h.ownerSessionVersion || 1));
    const token = await createSignedToken({
      type: 'owner',
      ownerId: String(first.id),
      homestayIds,
      ownerName: first.ownerName,
      whatsapp: cleanWhatsapp,
      passwordVersion: first.ownerPasswordVersion || 1,
      ownerSessionVersion: ownerSessionVersion
    }, env);

     const safeHomes = ownerHomes.map(({
        ownerPasswordHash, ownerSalt, ownerPasswordAlgorithm,
        ownerPasswordVersion, ownerSessionVersion, ...rest
      }) => rest);

      return new Response(JSON.stringify({
        success: true,
        homestays: safeHomes,
        message: 'Login successful'
        // no token field
      }), {
        status: 200,
        headers: {
          ...corsHeaders(request),
          'Set-Cookie': cookieHeader('owner_token', token, 86400)
        }
      });
    
  } catch (e) {
    console.error('Owner login error:', e.message, e.stack);
    return jsonResponse({ error: 'Server error. Please try again later.' }, 500, request);
  }
}
export async function onRequestOptions({ request }) { return new Response(null, { headers: corsHeaders(request) }); }
