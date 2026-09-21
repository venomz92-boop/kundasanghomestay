// /api/register.js — Guest registration.
//
// [THIS REVISION]
//  (1) Auto-login. On successful registration, the server issues the
//      session cookie and CSRF token in the SAME response. The guest
//      does not have to go to /login.html and type their password
//      again. They land back on the site already logged in.
//
//  (2) Verification email still sends, but is now a soft nudge — it no
//      longer gates login or booking. Its purpose is:
//         - a written record that we communicated with the guest
//           (useful for PDPA and for CHIP compliance)
//         - an optional security step the guest can do at any time
//      If the email provider is down, registration still succeeds.
//
//  (3) Existing-email handling simplified. Since unverified guests can
//      now log in normally, the old "resend verification to a stuck
//      account" path is no longer needed. If the email is already
//      registered, we tell the guest to log in or use Forgot Password.
//
//  (4) Removed the "no email provider configured → 503 fail" check.
//      Registration must not depend on email delivery.
//
// [LATEST REVISION]
// Guest session length changed from 2 hours to 30 days, matching the
// change in login.js. A newly-registered guest should not have to
// re-login the next morning just to finish a booking they started the
// night before.
//
// [SESSION COLLISION FIX]
// When a guest registers, the `admin_token` cookie is now explicitly
// cleared in the response. This prevents the same class of session-
// collision leak that was fixed in login.js: a browser that had an
// admin session (from a prior /admin.html login) and then registers
// as a guest would hold BOTH cookies. Killing the admin cookie on
// guest registration removes the ambiguity: one browser, one identity.
import {
  corsHeaders, getClientIP, enforceHttps, hashPassword, createSignedToken,
  generateCSRFToken, cookieHeader, clearCookieHeader, jsonResponse, parseJSONSafely, logAction,
  checkRateLimit, recordRateLimit
} from './_utils.js';

const GUEST_TTL_MS      = 30 * 24 * 60 * 60 * 1000;  // 30 days
const GUEST_TTL_SECONDS = GUEST_TTL_MS / 1000;

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { const d = String(phone).replace(/\D/g, ''); return d.length >= 10 && d.length <= 12; }
function clean(s, max = 200) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }

async function sendVerificationEmail(email, name, url, env) {
  const html = `<h2>Hello ${String(name || 'Guest').replace(/[<>]/g, '')}</h2>
    <p>Thank you for registering at Kundasang Homestay.</p>
    <p>Your account is already active — you can book and pay right away.</p>
    <p>Verifying your email is optional, but it secures your account and helps us reach you about your bookings:</p>
    <p><a href="${url}">Verify Email</a></p>
    <p>This link expires in 24 hours.</p>
    <p>If you did not create an account, please ignore this email.</p>`;

  // ---- Resend (preferred) ----
  if (env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: email,
          subject: 'Verify Your Email - Kundasang Homestay',
          html
        })
      });
      let data = null;
      try { data = await r.json(); } catch (_) { data = {}; }
      if (r.ok) {
        console.log(`✅ Verification email sent via Resend to ${email} (ID: ${data.id || 'n/a'})`);
        return true;
      }
      console.error(`❌ Resend error (HTTP ${r.status}):`, data);
      // fall through to SendGrid if configured
    } catch (e) {
      console.error('Resend send error:', e.message);
      // fall through to SendGrid if configured
    }
  }

  // ---- SendGrid (fallback) ----
  if (env.SENDGRID_API_KEY) {
    try {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Verify Your Email - Kundasang Homestay',
          content: [{ type: 'text/html', value: html }]
        })
      });
      if (r.ok) {
        console.log(`✅ Verification email sent via SendGrid to ${email}`);
        return true;
      }
      const txt = await r.text().catch(() => '');
      console.error(`❌ SendGrid error (HTTP ${r.status}): ${txt.slice(0, 200)}`);
      return false;
    } catch (e) {
      console.error('SendGrid send error:', e.message);
      return false;
    }
  }

  console.warn('No email provider configured (RESEND_API_KEY and SENDGRID_API_KEY are both missing). Verification email skipped — registration still succeeded.');
  return false;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // ---- Config checks. These give us explicit, actionable log lines. ----
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      console.error('❌ REGISTER FAIL: SESSION_SECRET is missing or shorter than 32 characters.');
      return jsonResponse(
        { error: 'Server configuration error. Please contact support.' },
        500,
        request
      );
    }
    if (!env.DB) {
      console.error('❌ REGISTER FAIL: D1 binding "DB" is not configured.');
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }
    // [THIS REVISION] Removed the "no email provider → 503 fail" check.
    // Registration succeeds even if email delivery is unavailable.

    const clientIP = getClientIP(request);
    const db = env.DB;

    // Rate limiting
    const rateOk = await checkRateLimit(db, clientIP, 'register', 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many registration attempts. Please wait 15 minutes.' }, 429, request);
    }

    let { name, email, phone, password } = await parseJSONSafely(request);
    name = clean(name, 100);
    email = String(email || '').toLowerCase().trim();
    phone = clean(phone, 30);
    password = String(password || '');

    if (!name || !email || !phone || !password) {
      return jsonResponse({ error: 'All fields are required' }, 400, request);
    }
    if (name.length < 2 || !validateEmail(email) || !validatePhone(phone) || password.length < 8) {
      return jsonResponse(
        { error: 'Please provide valid registration details. Password must be at least 8 characters.' },
        400,
        request
      );
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}

    // ---- Existing account check ----------------------------------------
    // [THIS REVISION] Simplified. Since unverified accounts can now log
    // in normally, there is no dead-end to escape. If the email is
    // already registered, direct the guest to log in or reset.
    const existingIndex = guests.findIndex(g => String(g.email || '').toLowerCase() === email);
    if (existingIndex !== -1) {
      await recordRateLimit(db, clientIP, 'register');
      return jsonResponse({
        error: 'This email is already registered. Please log in instead. If you cannot remember your password, use "Forgot Password" on the login page.'
      }, 400, request);
    }

    // ---- New account ------------------------------------------------
    const hashed = await hashPassword(password, env);

    const newGuest = {
      id: `G-${crypto.randomUUID()}`,
      name,
      email,
      phone,
      password: hashed.hash,
      salt: hashed.salt,
      passwordAlgorithm: hashed.algorithm,
      passwordVersion: 1,
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
      bookingsCount: 0,
      verified: false,
    };

    guests.push(newGuest);
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_guests', JSON.stringify(guests))
      .run();

    // ===== SEND VERIFICATION EMAIL (best effort, non-blocking) =====
    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    const verifyToken = await createSignedToken({
      type: 'email_verification',
      userId: newGuest.id,
      email: newGuest.email
    }, env, 24 * 60 * 60 * 1000);
    const verifyUrl = `${domain}/api/verify-email?token=${encodeURIComponent(verifyToken)}`;

    let emailSent = false;
    try {
      emailSent = await sendVerificationEmail(newGuest.email, newGuest.name, verifyUrl, env);
    } catch (mailErr) {
      console.error('Verification email threw unexpectedly:', mailErr.message);
      emailSent = false;
    }

    // ===== ISSUE SESSION (auto-login) =====
    const sessionVersion = newGuest.sessionVersion || 1;
    const sessionToken = await createSignedToken({
      type: 'guest',
      userId: String(newGuest.id),
      email: newGuest.email,
      passwordVersion: newGuest.passwordVersion || 1,
      sessionVersion: sessionVersion
    }, env, GUEST_TTL_MS);

    const csrfToken = await generateCSRFToken(newGuest.id, env);

    await logAction({
      db,
      action: 'guest_registered',
      admin: 'public',
      details: `Guest ${newGuest.id} registered (email: ${newGuest.email}, auto-logged in, verification email sent: ${emailSent})`,
      ip: clientIP,
      userId: newGuest.id
    });

    await recordRateLimit(db, clientIP, 'register');

    const { password: _, salt: __, ...safeGuest } = newGuest;

    const responseData = {
      success: true,
      guest: safeGuest,
      csrfToken,
      expiresIn: GUEST_TTL_SECONDS,
      message: emailSent
        ? 'Welcome to Kundasang Homestay! Your account is ready. We also sent a verification link to your email — verifying is optional but recommended for account security.'
        : 'Welcome to Kundasang Homestay! Your account is ready.'
    };

    // Build headers with TWO Set-Cookie directives:
    //   1. Set the new guest_token.
    //   2. Clear the admin_token so this browser can no longer be
    //      mistaken for an admin. Prevents the session-collision leak.
    const headers = new Headers(corsHeaders(request));
    headers.append('Set-Cookie', cookieHeader('guest_token', sessionToken, GUEST_TTL_SECONDS));
    headers.append('Set-Cookie', clearCookieHeader('admin_token'));

    return new Response(
      JSON.stringify(responseData),
      {
        status: 200,
        headers
      }
    );

  } catch (e) {
    // ---- Real logging so this shows up in Cloudflare's log viewer. ----
    console.error('❌ Register error:', e && e.message ? e.message : e);
    if (e && e.stack) console.error(e.stack);
    return jsonResponse({ error: 'Registration failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
