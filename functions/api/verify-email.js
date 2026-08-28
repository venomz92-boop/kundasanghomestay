// /api/verify-email.js
import { corsHeaders, enforceHttps, jsonResponse, verifySignedToken, getClientIP, logAction } from './_utils.js';

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  //console.log(`🔍 verify-email called with token: ${token ? token.substring(0, 20) + '...' : 'missing'}`);

  if (!token) {
    console.warn('❌ Missing token');
    return jsonResponse({ error: 'Missing verification token' }, 400, request);
  }

  try {
    // Verify the token
    const payload = await verifySignedToken(token, env);
   // console.log('📦 Decoded payload:', payload);

    if (!payload) {
      console.warn('❌ Invalid or expired token (verifySignedToken returned null)');
      return jsonResponse({ error: 'Invalid or expired token' }, 400, request);
    }

    if (payload.type !== 'email_verification') {
      console.warn(`❌ Wrong token type: expected 'email_verification', got '${payload.type}'`);
      return jsonResponse({ error: 'Invalid token type' }, 400, request);
    }

    const userId = payload.userId;
    const email = payload.email;
    if (!userId || !email) {
      console.warn('❌ Missing userId or email in payload');
      return jsonResponse({ error: 'Invalid token payload' }, 400, request);
    }

    const db = env.DB;
    if (!db) {
      console.error('❌ Database not configured');
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // Find guest by ID
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    if (r?.data) { try { guests = JSON.parse(r.data); } catch(_) { console.error('Failed to parse guests data'); } }

    const idx = guests.findIndex(g => String(g.id) === String(userId));
    if (idx === -1) {
      console.warn(`❌ User not found for id: ${userId}`);
      return jsonResponse({ error: 'User not found' }, 404, request);
    }

    if (guests[idx].verified === true) {
     // console.log(`✅ User ${email} already verified`);
      // Redirect to login with a message
      const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
      return Response.redirect(`${domain}/login.html?verified=already`, 302);
    }

    // Mark as verified
    guests[idx].verified = true;
    guests[idx].verifiedAt = new Date().toISOString();
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_guests', JSON.stringify(guests))
      .run();

    // console.log(`✅ Email ${email} verified successfully`);

    await logAction({
      db,
      action: 'email_verified',
      admin: 'guest',
      details: `Email verified for ${email}`,
      ip: getClientIP(request),
      userId: guests[idx].id
    });

    // Redirect to login with success
    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    return Response.redirect(`${domain}/login.html?verified=1`, 302);

  } catch (e) {
    console.error('❌ Verification error:', e.message, e.stack);
    return jsonResponse({ error: 'Verification failed. Please try again or contact support.' }, 500, request);
  }
}