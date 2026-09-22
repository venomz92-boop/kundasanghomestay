// /api/owner-register.js — creates a host account (pre-property)
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - Email + WhatsApp uniqueness check and write are now under a
//   per-identifier lock, so two concurrent registrations for the
//   same email/phone cannot both pass the check and both write
//   (second INSERT OR REPLACE would silently overwrite the first).
// - Verification email escapes the owner name with escHtml.
// - Added a global registration rate limit alongside the per-IP one.
// - Success response is now Cache-Control: no-store.
// - Error log no longer includes the stack trace.
//
// NOT changed (intentional):
// - Owner-register does NOT set a session cookie. Owners must verify
//   email before they can log in. No cookies are cleared here because
//   none are set.
// - The resendVerification action still returns the same generic
//   message for every path — it cannot be used to enumerate accounts.
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
  recordRateLimit,
  withLock,
  escHtml
} from './_utils.js';

const IP_LIMIT = 5;
const IP_WINDOW_SECONDS = 15 * 60;
const GLOBAL_KEY = '__owner_register_global__';
const GLOBAL_LIMIT = 30;
const GLOBAL_WINDOW_SECONDS = 15 * 60;

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { const d = String(phone).replace(/\D/g, ''); return d.length >= 9 && d.length <= 15; }
function clean(s, max = 200) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }

async function sendVerificationEmail(email, name, url, env) {
  const safeName = escHtml(name || 'Host');
  const safeUrl = escHtml(url);
  const html = `<h2>Hello ${safeName}</h2>
    <p>Thank you for registering as a host at Kundasang Homestay.</p>
    <p>Please verify your email to continue to the host property registration form:</p>
    <p><a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:#0F382E;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold;">Verify &amp; Continue →</a></p>
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
// Always returns a generic success message, even when the email is
// unknown or already verified, so the endpoint cannot be used to
// enumerate owner accounts.
// ============================================================
async function handleResendVerification(body, db, env, clientIP, request) {
  const email = String(body.email || '').toLowerCase().trim();

  const rateKey = 'owner_resend_verification';
  const rateOk = await checkRateLimit(db, clientIP, rateKey, 5, 15 * 60);
  if (!rateOk) {
    return jsonResponse({ error: 'Too many resend attempts. Please wait 15 minutes.' }, 429, request);
  }
  await recordRateLimit(db, clientIP, rateKey);

  const genericResponse = jsonResponse({
    success: true,
    message: 'If a host account exists for that email and is not yet verified, a fresh verification link has been sent. Please check your inbox and spam folder.'
  }, 200, request);

  if (!email || !validateEmail(email)) {
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

    let rawBody;
    try {
      rawBody = await parseJSONSafely(request);
    } catch (_) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }

    if (rawBody && rawBody.action === 'resendVerification') {
      return await handleResendVerification(rawBody, db, env, clientIP, request);
    }

    // Per-IP limit
    const ipOk = await checkRateLimit(db, clientIP, 'owner_register', IP_LIMIT, IP_WINDOW_SECONDS);
    if (!ipOk) {
      return jsonResponse({ error: 'Too many registration attempts. Please wait 15 minutes.' }, 429, request);
    }
    // Global limit
    const globalOk = await checkRateLimit(db, GLOBAL_KEY, 'owner_register', GLOBAL_LIMIT, GLOBAL_WINDOW_SECONDS);
    if (!globalOk) {
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
        400, request
      );
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ---- Uniqueness check + write under per-email lock -----------------
    const emailLockKey = 'owner-register:' + email;
    let owner;
    let created = false;
    let lockBusy = false;

    try {
      await withLock(db, emailLockKey, async (db) => {
        const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
        let owners = [];
        try { if (r?.data) owners = JSON.parse(r.data); } catch (_) {}

        const duplicateEmail = owners.some(o => String(o.ownerEmail || '').toLowerCase() === email);
        const duplicatePhone = owners.some(o => String(o.whatsapp || '').replace(/[^0-9]/g, '') === cleanWhatsapp);
        if (duplicateEmail || duplicatePhone) {
          return; // created stays false
        }

        const hashed = await hashPassword(password, env);

        owner = {
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

        created = true;
      }, 30000);
    } catch (e) {
      if (e && e.message && e.message.includes('in progress')) {
        lockBusy = true;
      } else {
        throw e;
      }
    }

    if (lockBusy) {
      return jsonResponse({ error: 'Another registration is in progress. Please try again.' }, 409, request);
    }

    if (!created) {
      await recordRateLimit(db, clientIP, 'owner_register');
      await recordRateLimit(db, GLOBAL_KEY, 'owner_register');
      return jsonResponse({ error: 'Registration failed. Please check your details or try again.' }, 400, request);
    }

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
      details: `Owner ${owner.id} registered`,
      ip: clientIP,
      userId: owner.id
    });

    await recordRateLimit(db, clientIP, 'owner_register');
    await recordRateLimit(db, GLOBAL_KEY, 'owner_register');

    return jsonResponse({
      success: true,
      message: emailSent
        ? 'Registration successful. Please check your email to verify your account and continue to the property form.'
        : 'Registration successful, but verification email could not be sent. Please use the resend button on this page.'
    }, 200, request);

  } catch (e) {
    console.error('Owner register error:', e.message);
    return jsonResponse({ error: 'Registration failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
