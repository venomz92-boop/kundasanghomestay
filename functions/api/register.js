// /api/register.js — Guest registration.
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - generateCSRFToken now receives the new guest's sessionVersion.
//   Without this the CSRF token was issued with sv=0 while the
//   session was created at sv=1, so a freshly-registered guest's
//   FIRST booking returned 403 CSRF_INVALID. (Same regression as
//   login.js; caught during review.)
// - Email-uniqueness check + write are now wrapped in a per-email
//   withLock so two concurrent registrations for the same address
//   cannot both pass the check and both write (one would silently
//   overwrite the other via INSERT OR REPLACE).
// - Verification email now escapes the guest's name with escHtml
//   instead of the incomplete .replace(/[<>]/g,'').
// - Added a global registration rate limit in parallel with the
//   per-IP one.
// - Success response is now Cache-Control: no-store.
// - Error log no longer includes the stack trace.
//
// Design notes (unchanged, still intentional):
// - Auto-login: session + CSRF are issued in the same response.
// - Verification email is a soft nudge; it does NOT gate login or
//   booking. Registration succeeds even if email delivery is down.
// - admin_token is cleared on register (session-collision fix).
// - owner_token is deliberately NOT cleared (guest + owner
//   coexistence is a supported scenario per /api/_middleware.js).
import {
  corsHeaders, getClientIP, enforceHttps, hashPassword, createSignedToken,
  generateCSRFToken, cookieHeader, clearCookieHeader, jsonResponse, parseJSONSafely, logAction,
  checkRateLimit, recordRateLimit, withLock, escHtml
} from './_utils.js';

const GUEST_TTL_MS      = 30 * 24 * 60 * 60 * 1000;  // 30 days
const GUEST_TTL_SECONDS = GUEST_TTL_MS / 1000;

// Per-IP limits
const IP_LIMIT = 5;
const IP_WINDOW_SECONDS = 15 * 60;
// Global limit — fixed sentinel, not an IP address.
const GLOBAL_KEY = '__register_global__';
const GLOBAL_LIMIT = 30;
const GLOBAL_WINDOW_SECONDS = 15 * 60;

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { const d = String(phone).replace(/\D/g, ''); return d.length >= 10 && d.length <= 12; }
function clean(s, max = 200) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }

async function sendVerificationEmail(email, name, url, env) {
  const safeName = escHtml(name || 'Guest');
  const html = `<h2>Hello ${safeName}</h2>
    <p>Thank you for registering at Kundasang Homestay.</p>
    <p>Your account is already active — you can book and pay right away.</p>
    <p>Verifying your email is optional, but it secures your account and helps us reach you about your bookings:</p>
    <p><a href="${escHtml(url)}">Verify Email</a></p>
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
        console.log(`Verification email sent via Resend (ID: ${data.id || 'n/a'})`);
        return true;
      }
      console.error(`Resend error (HTTP ${r.status})`);
    } catch (e) {
      console.error('Resend send error:', e.message);
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
        console.log('Verification email sent via SendGrid');
        return true;
      }
      console.error(`SendGrid error (HTTP ${r.status})`);
      return false;
    } catch (e) {
      console.error('SendGrid send error:', e.message);
      return false;
    }
  }

  console.warn('No email provider configured. Verification email skipped — registration still succeeded.');
  return false;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      console.error('REGISTER FAIL: SESSION_SECRET is missing or shorter than 32 characters.');
      return jsonResponse(
        { error: 'Server configuration error. Please contact support.' },
        500, request
      );
    }
    if (!env.DB) {
      console.error('REGISTER FAIL: D1 binding "DB" is not configured.');
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    const clientIP = getClientIP(request);
    const db = env.DB;

    // Per-IP limit
    const ipOk = await checkRateLimit(db, clientIP, 'register', IP_LIMIT, IP_WINDOW_SECONDS);
    if (!ipOk) {
      return jsonResponse({ error: 'Too many registration attempts. Please wait 15 minutes.' }, 429, request);
    }
    // Global limit
    const globalOk = await checkRateLimit(db, GLOBAL_KEY, 'register', GLOBAL_LIMIT, GLOBAL_WINDOW_SECONDS);
    if (!globalOk) {
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
        400, request
      );
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ---- Email-uniqueness check + write, under a per-email lock --------
    // Without the lock, two concurrent registrations for the same email
    // can both pass the existingIndex check, then both write, and the
    // second INSERT OR REPLACE silently overwrites the first user.
    const emailLockKey = 'register:' + email;
    let newGuest;
    let created = false;
    let lockBusy = false;

    try {
      await withLock(db, emailLockKey, async (db) => {
        const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
        let guests = [];
        try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}

        const existingIndex = guests.findIndex(g => String(g.email || '').toLowerCase() === email);
        if (existingIndex !== -1) {
          return; // created stays false
        }

        const hashed = await hashPassword(password, env);

        newGuest = {
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
      await recordRateLimit(db, clientIP, 'register');
      await recordRateLimit(db, GLOBAL_KEY, 'register');
      return jsonResponse({
        error: 'This email is already registered. Please log in instead. If you cannot remember your password, use "Forgot Password" on the login page.'
      }, 400, request);
    }

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
    const sessionVersion = Number(newGuest.sessionVersion ?? 1);
    const sessionToken = await createSignedToken({
      type: 'guest',
      userId: String(newGuest.id),
      email: newGuest.email,
      passwordVersion: Number(newGuest.passwordVersion ?? 1),
      sessionVersion: sessionVersion
    }, env, GUEST_TTL_MS);

    // CSRF token MUST be issued under the same sessionVersion as the
    // session token, or the session-bound CSRF check will reject it.
    const csrfToken = await generateCSRFToken(newGuest.id, env, sessionVersion);

    await logAction({
      db,
      action: 'guest_registered',
      admin: 'public',
      details: `Guest ${newGuest.id} registered (auto-logged in, verification email sent: ${emailSent})`,
      ip: clientIP,
      userId: newGuest.id
    });

    await recordRateLimit(db, clientIP, 'register');
    await recordRateLimit(db, GLOBAL_KEY, 'register');

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

    // Two Set-Cookie directives:
    //   1. Set the new guest_token.
    //   2. Clear admin_token (session-collision fix).
    // owner_token is intentionally left alone.
    const headers = new Headers(corsHeaders(request));
    headers.set('Cache-Control', 'no-store');
    headers.append('Set-Cookie', cookieHeader('guest_token', sessionToken, GUEST_TTL_SECONDS));
    headers.append('Set-Cookie', clearCookieHeader('admin_token'));

    return new Response(
      JSON.stringify(responseData),
      { status: 200, headers }
    );

  } catch (e) {
    console.error('Register error:', e && e.message ? e.message : e);
    return jsonResponse({ error: 'Registration failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
