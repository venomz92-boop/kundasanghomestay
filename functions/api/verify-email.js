// /api/verify-email.js
import {
  corsHeaders,
  enforceHttps,
  jsonResponse,
  verifySignedToken,
  getClientIP,
  logAction
} from './_utils.js';

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return jsonResponse({ error: 'Missing verification token' }, 400, request);
  }

  const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';

  try {
    const payload = await verifySignedToken(token, env);

    if (!payload) {
      return jsonResponse({ error: 'Invalid or expired token' }, 400, request);
    }

    if (payload.type !== 'email_verification') {
      return jsonResponse({ error: 'Invalid token type' }, 400, request);
    }

    const userId = payload.userId;
    const email = payload.email;
    if (!userId || !email) {
      return jsonResponse({ error: 'Invalid token payload' }, 400, request);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    if (r?.data) {
      try { guests = JSON.parse(r.data); } catch (_) { guests = []; }
    }

    const idx = guests.findIndex(g => String(g.id) === String(userId));
    if (idx === -1) {
      return jsonResponse({ error: 'User not found' }, 404, request);
    }

    // Already verified — redirect with "already" flag
    if (guests[idx].verified === true) {
      return new Response(null, {
        status: 302,
        headers: { 'Location': `${domain}/login.html?verified=already` }
      });
    }

    // Mark as verified
    guests[idx].verified = true;
    guests[idx].verifiedAt = new Date().toISOString();

    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_guests', JSON.stringify(guests))
      .run();

    await logAction({
      db,
      action: 'email_verified',
      admin: 'guest',
      details: `Email verified for ${email}`,
      ip: getClientIP(request),
      userId: guests[idx].id
    });

    // Redirect to login with success
    return new Response(null, {
      status: 302,
      headers: { 'Location': `${domain}/login.html?verified=1` }
    });

  } catch (e) {
    console.error('Verification error:', e.message, e.stack);
    return jsonResponse({ error: 'Verification failed. Please try again or contact support.' }, 500, request);
  }
}
