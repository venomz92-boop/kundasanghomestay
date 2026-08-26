// /api/verify-email.js
import { corsHeaders, enforceHttps, jsonResponse, verifySignedToken } from './_utils.js';

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return jsonResponse({ error: 'Missing verification token' }, 400, request);
  }

  try {
    const payload = await verifySignedToken(token, env);
    if (!payload || payload.type !== 'email_verification') {
      return jsonResponse({ error: 'Invalid or expired token' }, 400, request);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // Find guest by ID
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    if (r?.data) { try { guests = JSON.parse(r.data); } catch(_) {} }
    const idx = guests.findIndex(g => String(g.id) === String(payload.userId));
    if (idx === -1) {
      return jsonResponse({ error: 'User not found' }, 404, request);
    }
    if (guests[idx].verified === true) {
      return jsonResponse({ message: 'Email already verified' }, 200, request);
    }

    guests[idx].verified = true;
    guests[idx].verifiedAt = new Date().toISOString();
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_guests', JSON.stringify(guests))
      .run();

    await logAction({
      db,
      action: 'email_verified',
      admin: 'guest',
      details: `Email verified for ${guests[idx].email}`,
      ip: getClientIP(request),
      userId: guests[idx].id
    });

    // Redirect to login with success message
    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    return Response.redirect(`${domain}/login.html?verified=1`, 302);
  } catch (e) {
    console.error('Email verification error:', e);
    return jsonResponse({ error: 'Verification failed' }, 500, request);
  }
}
