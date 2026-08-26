// /api/login.js – (top of file)
import { corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword, createSignedToken, generateCSRFToken, cookieHeader, jsonResponse, checkRateLimit, recordRateLimit, parseJSONSafely, logAction, incrementSessionVersion } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

async function sendVerificationEmail(to, name, url, env) {
  const html = `<h2>Hello ${name},</h2><p>Please verify your email address for Kundasang Homestay.</p><p><a href="${url}">Verify Email</a></p><p>This link expires in 24 hours.</p>`;
  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: to,
          subject: 'Verify Your Email - Kundasang Homestay',
          html
        })
      });
      return r.ok;
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Verify Your Email - Kundasang Homestay',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return r.ok;
    }
  } catch (e) {
    console.error('Email send error:', e);
  }
  return false;
}

export async function onRequestPost({ request, env }) {
  try {
    const redirect = enforceHttps(request);
    if (redirect) return redirect;

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      console.error('DB not configured');
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    // Rate limiting
    const rateOk = await checkRateLimit(db, clientIP, 'login', 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }

    let body;
    try {
      body = await parseJSONSafely(request);
    } catch (e) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }
    const { email, password } = body;
    const cleanEmail = String(email || '').toLowerCase().trim();
    const cleanPassword = String(password || '');

    if (!validateEmail(cleanEmail) || !cleanPassword) {
      await recordRateLimit(db, clientIP, 'login');
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    const bannedR = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_banned_guests').first();

    let guests = [], banned = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}
    try { if (bannedR?.data) banned = JSON.parse(bannedR.data); } catch (_) {}

    if (banned.includes(cleanEmail)) {
      await recordRateLimit(db, clientIP, 'login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const user = guests.find(g => String(g.email || '').toLowerCase() === cleanEmail);
    if (!user) {
      await recordRateLimit(db, clientIP, 'login');
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    console.log(`🔍 Login attempt for ${user.email}:`, {
      id: user.id,
      verified: user.verified,
      hasPassword: !!user.password,
      passwordVersion: user.passwordVersion,
      sessionVersion: user.sessionVersion
    });

    // Migration: set verified true for old users
    if (user.verified === undefined) {
      user.verified = true;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests))
        .run();
      console.log(`✅ Migrated old guest ${user.email} - set verified=true`);
    }

    // Email verification check
    if (user.verified !== true) {
      const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
      const verifyToken = await createSignedToken({
        type: 'email_verification',
        userId: user.id,
        email: user.email
      }, env, 24 * 60 * 60 * 1000);
      const verifyUrl = `${domain}/api/verify-email?token=${encodeURIComponent(verifyToken)}`;
      const emailSent = await sendVerificationEmail(user.email, user.name, verifyUrl, env);
      if (emailSent) {
        await logAction({
          db,
          action: 'verification_resent_on_login',
          admin: 'guest',
          details: `Resent verification to ${user.email}`,
          ip: clientIP,
          userId: user.id
        });
      } else {
        console.error(`❌ Failed to send verification email to ${user.email}`);
      }
      console.warn(`❌ Login blocked - ${user.email} not verified (verified: ${user.verified})`);
      return jsonResponse({
        error: 'Please verify your email address first. A new verification link has been sent to your email.',
        needsVerification: true
      }, 401, request);
    }

    // Verify password
    const verified = await verifyPassword(cleanPassword, user, env);
    if (!verified.ok) {
      await recordRateLimit(db, clientIP, 'login');
      console.warn(`❌ Password mismatch for ${user.email}`);
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }

    // Legacy migration
    if (verified.legacy) {
      const fresh = await hashPassword(cleanPassword, env);
      user.password = fresh.hash;
      user.salt = fresh.salt;
      user.passwordAlgorithm = fresh.algorithm;
      user.passwordVersion = (user.passwordVersion || 0) + 1;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(guests))
        .run();
    }

    await incrementSessionVersion(db, user.id, 'guest');

    const session = await createSignedToken({
      type: 'guest',
      userId: String(user.id),
      email: user.email,
      passwordVersion: user.passwordVersion || 1,
      sessionVersion: (user.sessionVersion || 0) + 1
    }, env);

    const csrfToken = await generateCSRFToken(user.id, env);
    const { password: _, salt: __, ...safeUser } = user;

    console.log(`✅ Login successful for ${user.email}`);

    return new Response(JSON.stringify({
      success: true,
      guest: safeUser,
      token: session,
      csrfToken,
      message: 'Login successful'
    }), {
      status: 200,
      headers: {
        ...corsHeaders(request),
        'Set-Cookie': cookieHeader('guest_token', session)
      }
    });

  } catch (e) {
    console.error('Login error:', e.message, e.stack);
    // Always return JSON
    return jsonResponse({ error: 'Login failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
