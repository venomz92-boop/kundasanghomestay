// /api/register.js — Guest registration.
// Plain English: this file now LOGS the real error message when a
// registration fails, so you can see it in the Cloudflare log viewer
// instead of guessing. Nothing else changed.
//
// FIX #8 (option a): if someone re-registers with an email that exists
// but is NOT yet verified, we resend the verification email using the
// original stored account — we do NOT overwrite their password / name /
// phone. This breaks the "can't login (unverified) AND can't re-register
// (email exists)" dead-end. Verified accounts still get the same generic
// rejection as before.
//
// [THIS REVISION]
// sendVerificationEmail now supports BOTH Resend and SendGrid, matching
// every other email-sending file in the codebase. Previously it only
// checked RESEND_API_KEY, so a SendGrid-only deployment silently failed
// to deliver guest verification emails — which meant no guest could
// verify their email and therefore no guest could log in.
import { corsHeaders, getClientIP, enforceHttps, hashPassword, createSignedToken, jsonResponse, parseJSONSafely, logAction, checkRateLimit, recordRateLimit } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { const d = String(phone).replace(/\D/g, ''); return d.length >= 10 && d.length <= 12; }
function clean(s, max = 200) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }

async function sendVerificationEmail(email, name, url, env) {
  const html = `<h2>Hello ${String(name || 'Guest').replace(/[<>]/g, '')}</h2>
    <p>Thank you for registering at Kundasang Homestay.</p>
    <p>Please verify your email address by clicking the link below:</p>
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

  console.warn('No email provider configured (RESEND_API_KEY and SENDGRID_API_KEY are both missing).');
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
    if (!env.RESEND_API_KEY && !env.SENDGRID_API_KEY) {
      console.error('❌ REGISTER FAIL: Neither RESEND_API_KEY nor SENDGRID_API_KEY is set. Verification emails cannot be delivered.');
      return jsonResponse(
        { error: 'Email service is temporarily unavailable. Please contact support@kundasanghomestay.my' },
        503,
        request
      );
    }

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
    // FIX #8 (option a): an account may already exist for this email.
    //  - If it is verified: they should log in, not re-register. Return the
    //    same generic rejection as before (no account-existence leak).
    //  - If it is UNVERIFIED: the guest is otherwise dead-ended (cannot log
    //    in because unverified; cannot re-register because email exists).
    //    We idempotently resend the verification email using the ORIGINAL
    //    stored account. We deliberately do NOT overwrite their stored
    //    password / name / phone — that would let anyone who knows the
    //    email take over an unverified account by submitting a new one.
    const existingIndex = guests.findIndex(g => String(g.email || '').toLowerCase() === email);
    if (existingIndex !== -1) {
      const existing = guests[existingIndex];

      if (existing.verified === true) {
        return jsonResponse(
          { error: 'Registration failed. Please check your details or try again.' },
          400,
          request
        );
      }

      // Resend verification email for the existing unverified account.
      const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
      const resendToken = await createSignedToken({
        type: 'email_verification',
        userId: existing.id,
        email: existing.email
      }, env, 24 * 60 * 60 * 1000);
      const resendUrl = `${domain}/api/verify-email?token=${encodeURIComponent(resendToken)}`;

      const resendSent = await sendVerificationEmail(existing.email, existing.name, resendUrl, env);

      await logAction({
        db,
        action: 'guest_verification_resent',
        admin: 'public',
        details: `Verification resent for unverified guest ${existing.id} (email: ${existing.email}, sent: ${resendSent})`,
        ip: clientIP,
        userId: existing.id
      });

      await recordRateLimit(db, clientIP, 'register');

      const resendMessage = resendSent
        ? 'A fresh verification link has been emailed to this address. Please check your inbox (and your spam folder), then click the link to activate your account.'
        : 'We found an unverified account for this email, but could not send the verification email right now. Please wait a few minutes and try again, or contact support.';

      return jsonResponse(
        { success: true, resent: true, message: resendMessage },
        200,
        request
      );
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

    // ===== SEND VERIFICATION EMAIL (best effort) =====
    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    const verifyToken = await createSignedToken({
      type: 'email_verification',
      userId: newGuest.id,
      email: newGuest.email
    }, env, 24 * 60 * 60 * 1000);
    const verifyUrl = `${domain}/api/verify-email?token=${encodeURIComponent(verifyToken)}`;

    const emailSent = await sendVerificationEmail(newGuest.email, newGuest.name, verifyUrl, env);

    await logAction({
      db,
      action: 'guest_registered',
      admin: 'public',
      details: `Guest ${newGuest.id} registered (email: ${newGuest.email}, verification email sent: ${emailSent})`,
      ip: clientIP,
      userId: newGuest.id
    });

    await recordRateLimit(db, clientIP, 'register');

    const { password: _, salt: __, ...safeGuest } = newGuest;

    const responseData = {
      success: true,
      guest: safeGuest,
      message: emailSent
        ? 'Registration successful. Please check your email to verify your account before logging in. You can close this window now.'
        : 'Registration successful, but verification email could not be sent. Please use the "Resend verification" button on the login page or contact support.',
    };

    return new Response(
      JSON.stringify(responseData),
      {
        status: 200,
        headers: {
          ...corsHeaders(request)
        }
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
