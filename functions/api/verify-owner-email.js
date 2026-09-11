// /api/verify-owner-email.js — verifies owner email, sets cookie, redirects to list.html
import {
  corsHeaders,
  enforceHttps,
  jsonResponse,
  verifySignedToken,
  createSignedToken,
  cookieHeader,
  getClientIP,
  logAction
} from './_utils.js';

const OWNER_TTL_SECONDS = 24 * 60 * 60; // 24h

function redirectTo(url, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { 'Location': url, ...extraHeaders }
  });
}

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';

  if (!token) {
    return redirectTo(`${domain}/login.html?error=missing_token`);
  }

  try {
    const payload = await verifySignedToken(token, env);
    if (!payload || payload.type !== 'owner_email_verification') {
      return redirectTo(`${domain}/login.html?error=invalid_token`);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
    let owners = [];
    try { if (r?.data) owners = JSON.parse(r.data); } catch (_) {}

    const idx = owners.findIndex(o => String(o.id) === String(payload.userId));
    if (idx === -1) {
      return redirectTo(`${domain}/login.html?error=user_not_found`);
    }

    const owner = owners[idx];

    if (owner.verified === true) {
      const session = await createSignedToken({
        type: 'owner',
        ownerId: owner.whatsapp,
        whatsapp: owner.whatsapp,
        ownerName: owner.ownerName,
        homestayIds: [],
        ownerSessionVersion: owner.ownerSessionVersion || 1
      }, env, OWNER_TTL_SECONDS * 1000);

      return redirectTo(
        `${domain}/list.html?verified=already`,
        { 'Set-Cookie': cookieHeader('owner_token', session, OWNER_TTL_SECONDS) }
      );
    }

    owners[idx].verified = true;
    owners[idx].verifiedAt = new Date().toISOString();
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_owners', JSON.stringify(owners))
      .run();

    // Collect any existing homestays already owned by this whatsapp
    let homestayIds = [];
    for (const key of ['kd_approved', 'kd_pending']) {
      const rr = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
      if (!rr?.data) continue;
      try {
        const arr = JSON.parse(rr.data);
        homestayIds = homestayIds.concat(
          arr
            .filter(h => String(h.whatsapp || '').replace(/[^0-9]/g, '') === owner.whatsapp)
            .map(h => String(h.id))
        );
      } catch (_) {}
    }

    const session = await createSignedToken({
      type: 'owner',
      ownerId: owner.whatsapp,
      whatsapp: owner.whatsapp,
      ownerName: owner.ownerName,
      homestayIds: homestayIds,
      ownerSessionVersion: owner.ownerSessionVersion || 1
    }, env, OWNER_TTL_SECONDS * 1000);

    await logAction({
      db,
      action: 'owner_email_verified',
      admin: 'owner',
      details: `Email verified for ${owner.ownerEmail}`,
      ip: getClientIP(request),
      userId: owner.id
    });

    return redirectTo(
      `${domain}/list.html?verified=1`,
      { 'Set-Cookie': cookieHeader('owner_token', session, OWNER_TTL_SECONDS) }
    );

  } catch (e) {
    console.error('Owner verification error:', e.message, e.stack);
    return redirectTo(`${domain}/login.html?error=server_error`);
  }
}
