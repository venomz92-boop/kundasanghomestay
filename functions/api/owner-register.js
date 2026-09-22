// /api/owner-register.js — creates a host account (pre-property)
//
// [THIS REVISION]
// Adds a `resendVerification` action on the same endpoint. When a host's
// first verification email never arrived (spam folder, typo, delivery
// failure), they can now request a new one from owner-register.html or
// owner.html without having to re-register. The action always returns
// success regardless of whether the email exists or the account is already
// verified, so it cannot be used to enumerate owner accounts.
import {
  corsHeaders,
  getClientIP,
  enforceHttps,
  hashPassword,
  createSignedToken,
  jsonResponse,
  parseJSONSafely,
  logAction,
  checkRateLimit,
  recordRateLimit
} from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { const d = String(phone).replace(/\D/g, ''); return d.length >= 9 && d.length <= 15; }
function clean(s, max = 200) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }

async function sendVerificationEmail(email, name, url, env) {
  const html = `<h2>Hello ${String(name || 'Host').replace(/[<>]/g, '')}</h2>
    <p>Thank you for registering as a host at Kundasang Homestay.</p>
    <p>Please verify your email to continue to the host property registration form:</p>
    <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#0F382E;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold;">Verify &amp; Continue →</a></p>
    <p>This link expires in 24 hours.</p>
    <p>If you did not create this account, please ignore this email.</p>`;

  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: email,
          subject: 'Verify Your Host Account - Kundasang Homestay',
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
          personalizations: [{ to: [{ email }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Verify Your Host Account - Kundasang Homestay',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return r.ok;
    }
  } catch (e) {
    console.error('Owner verification email error:', e.message);
  }
  return false;
}

// ============================================================
// Resend verification action.
// Called from owner-register.html (success state) and owner.html
// (login error when unverified). Always returns a generic success
// message, even when the email is unknown or already verified, so
// the endpoint cannot be used to enumerate owner accounts.
// ============================================================
async function handleResendVerification(body, db, env, clientIP, request) {
  const email = String(body.email || '').toLowerCase().trim();

  const rateKey = 'owner_resend_verification';
  const rateOk = await checkRateLimit(db, clientIP, rateKey, 5, 15 * 60);
  if (!rateOk) {
    return jsonResponse({ error: 'Too many resend attempts. Please wait 15 minutes.' }, 429, request);
  }
  await recordRateLimit(db, clientIP, rateKey);

  // Generic response for every path — success shape, no leak.
  const genericResponse = jsonResponse({
    success: true,
    message: 'If a host account exists for that email and is not yet verified, a fresh verification link has been sent. Please check your inbox and spam folder.'
  }, 200, request);

  if (!email || !validateEmail(email)) {
    // Still return the generic response — never confirm whether the
    // email is registered.
    return genericResponse;
  }

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
    let owners = [];
    try { if (r?.data) owners = JSON.parse(r.data); } catch (_) {}

    const idx = owners.findIndex(o => String(o.ownerEmail || '').toLowerCase().trim() === email);
    if (idx === -1) return genericResponse;
    if (owners[idx].verified === true) return genericResponse;

    // Regenerate a fresh token and resend.
    const owner = owners[idx];
    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    const verifyToken = await createSignedToken({
      type: 'owner_email_verification',
      userId: owner.id,
      email: owner.ownerEmail
    }, env, 24 * 60 * 60 * 1000);
    const verifyUrl = `${domain}/api/verify-owner-email?token=${encodeURIComponent(verifyToken)}`;

    const sent = await sendVerificationEmail(owner.ownerEmail, owner.ownerName, verifyUrl, env);

    await logAction({
      db,
      action: 'owner_verification_resent',
      admin: 'public',
      details: `Verification resent for unverified owner ${owner.id} (sent: ${sent})`,
      ip: clientIP,
      userId: owner.id
    });
  } catch (e) {
    console.error('Resend verification error:', e.message);
    // Fall through to the generic response — never reveal failure to
    // the caller in a way that distinguishes account existence.
  }

  return genericResponse;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      return jsonResponse({ error: 'Server configuration error. Please contact support.' }, 500, request);
    }

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);

    // Parse the body once, up front, so we can route to the resend
    // action before touching the registration rate limit.
    let rawBody;
    try {
      rawBody = await parseJSONSafely(request);
    } catch (_) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }

    // NEW: resend verification action
    if (rawBody && rawBody.action === 'resendVerification') {
      return await handleResendVerification(rawBody, db, env, clientIP, request);
    }

    const rateOk = await checkRateLimit(db, clientIP, 'owner_register', 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many registration attempts. Please wait 15 minutes.' }, 429, request);
    }

    let { name, email, phone, password } = rawBody || {};
    name = clean(name, 100);
    email = String(email || '').toLowerCase().trim();
    phone = clean(phone, 30);
    password = String(password || '');
    const cleanWhatsapp = String(phone).replace(/[^0-9]/g, '');

    if (!name || !email || !cleanWhatsapp || !password) {
      return jsonResponse({ error: 'All fields are required' }, 400, request);
    }
    if (name.length < 2 || !validateEmail(email) || !validatePhone(cleanWhatsapp) || password.length < 8) {
      return jsonResponse(
        { error: 'Please provide valid details. Password must be at least 8 characters.' },
        400,
        request
      );
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
    let owners = [];
    try { if (r?.data) owners = JSON.parse(r.data); } catch (_) {}

    const duplicateEmail = owners.some(o => String(o.ownerEmail || '').toLowerCase() === email);
    const duplicatePhone = owners.some(o => String(o.whatsapp || '').replace(/[^0-9]/g, '') === cleanWhatsapp);
    if (duplicateEmail || duplicatePhone) {
      return jsonResponse({ error: 'Registration failed. Please check your details or try again.' }, 400, request);
    }

    const hashed = await hashPassword(password, env);

    const owner = {
      id: `O-${crypto.randomUUID()}`,
      ownerName: name,
      ownerEmail: email,
      whatsapp: cleanWhatsapp,
      ownerPasswordHash: hashed.hash,
      ownerSalt: hashed.salt,
      ownerPasswordAlgorithm: hashed.algorithm,
      ownerPasswordVersion: 1,
      ownerSessionVersion: 1,
      verified: false,
      verifiedAt: null,
      createdAt: new Date().toISOString()
    };

    owners.push(owner);
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_owners', JSON.stringify(owners))
      .run();

    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    const verifyToken = await createSignedToken({
      type: 'owner_email_verification',
      userId: owner.id,
      email: owner.ownerEmail
    }, env, 24 * 60 * 60 * 1000);
    const verifyUrl = `${domain}/api/verify-owner-email?token=${encodeURIComponent(verifyToken)}`;

    const emailSent = await sendVerificationEmail(owner.ownerEmail, owner.ownerName, verifyUrl, env);

    await logAction({
      db,
      action: 'owner_registered',
      admin: 'public',
      details: `Owner ${owner.id} registered (email: ${owner.ownerEmail})`,
      ip: clientIP,
      userId: owner.id
    });

    await recordRateLimit(db, clientIP, 'owner_register');

    return jsonResponse({
      success: true,
      message: emailSent
        ? 'Registration successful. Please check your email to verify your account and continue to the property form.'
        : 'Registration successful, but verification email could not be sent. Please use the resend button on this page.'
    }, 200, request);

  } catch (e) {
    console.error('Owner register error:', e.message, e.stack);
    return jsonResponse({ error: 'Registration failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}
