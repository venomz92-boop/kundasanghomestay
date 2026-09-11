// /api/owner-login.js — Host login (timing-safe, multi-device)
import {
  corsHeaders, getClientIP, enforceHttps, verifyPassword, hashPassword,
  createSignedToken, cookieHeader, jsonResponse, checkRateLimit,
  recordRateLimit, parseJSONSafely
} from './_utils.js';

// Dummy record for timing equalization on unknown WhatsApp numbers
const DUMMY_OWNER_RECORD = {
  ownerPasswordHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ownerSalt: 'AAAAAAAAAAAAAAAAAAAAAA',
  ownerPasswordAlgorithm: 'PBKDF2-100000-SHA256'
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

    const a = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
    const p = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_pending').first();
    let homes = [];
    try { if (a?.data) homes = JSON.parse(a.data); } catch(_) {}
    try { if (p?.data) homes = homes.concat(JSON.parse(p.data)); } catch(_) {}

    const ownerHomes = homes.filter(h =>
      String(h.whatsapp || '').replace(/[^0-9]/g, '') === cleanWhatsapp &&
      h.ownerPasswordHash && h.ownerSalt
    );

    // ---- TIMING-SAFE PATH ----
    // Always run PBKDF2, even when the WhatsApp number is unknown.
    const recordToCheck = ownerHomes.length > 0
      ? {
          ownerPasswordHash: ownerHomes[0].ownerPasswordHash,
          ownerSalt: ownerHomes[0].ownerSalt,
          ownerPasswordAlgorithm: ownerHomes[0].ownerPasswordAlgorithm
        }
      : DUMMY_OWNER_RECORD;

    const checked = await verifyPassword(cleanPassword, recordToCheck, env);

    if (ownerHomes.length === 0 || !checked.ok) {
      await recordRateLimit(db, clientIP, 'owner_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const first = ownerHomes[0];

    // Migrate legacy password
    if (checked.legacy) {
      const fresh = await hashPassword(cleanPassword, env);
      const version = (first.ownerPasswordVersion || 0) + 1;
      for (const h of ownerHomes) {
        h.ownerPasswordHash = fresh.hash;
        h.ownerSalt = fresh.salt;
        h.ownerPasswordAlgorithm = fresh.algorithm;
        h.ownerPasswordVersion = version;
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

    // ---- MULTI-DEVICE POLICY ----
    // Do NOT increment ownerSessionVersion on login. Multiple devices are
    // allowed. Password reset is the only thing that force-invalidates all.
    const ownerSessionVersion = Math.max(...ownerHomes.map(h => h.ownerSessionVersion || 0));

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
      token,
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
