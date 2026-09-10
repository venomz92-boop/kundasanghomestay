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

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';

  if (!token) {
    return Response.redirect(`${domain}/login.html?error=missing_token`, 302);
  }

  try {
    const payload = await verifySignedToken(token, env);
    if (!payload || payload.type !== 'owner_email_verification') {
      return Response.redirect(`${domain}/login.html?error=invalid_token`, 302);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
    let owners = [];
    try { if (r?.data) owners = JSON.parse(r.data); } catch (_) {}

    const idx = owners.findIndex(o => String(o.id) === String(payload.userId));
    if (idx === -1) {
      return Response.redirect(`${domain}/login.html?error=user_not_found`, 302);
    }

    if (owners[idx].verified === true) {
      // Already verified — issue a session and redirect to list.html
      const owner = owners[idx];
      const session = await createSignedToken({
        type: 'owner',
        ownerId: owner.whatsapp,
        whatsapp: owner.whatsapp,
        ownerName: owner.ownerName,
        homestayIds: [],
        ownerSessionVersion: owner.ownerSessionVersion || 1
      }, env, OWNER_TTL_SECONDS * 1000);

      return new Response(null, {
        status: 302,
        headers: {
          'Location': `${domain}/list.html?verified=already`,
          'Set-Cookie': cookieHeader('owner_token', session, OWNER_TTL_SECONDS)
        }
      });
    }

    owners[idx].verified = true;
    owners[idx].verifiedAt = new Date().toISOString();
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_owners', JSON.stringify(owners))
      .run();

    const owner = owners[idx];

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

    return new Response(null, {
      status: 302,
      headers: {
        'Location': `${domain}/list.html?verified=1`,
        'Set-Cookie': cookieHeader('owner_token', session, OWNER_TTL_SECONDS)
      }
    });

  } catch (e) {
    console.error('Owner verification error:', e.message, e.stack);
    return Response.redirect(`${domain}/login.html?error=server_error`, 302);
  }
}
