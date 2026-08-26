// /api/register.js
import { corsHeaders, getClientIP, enforceHttps, hashPassword, generateCSRFToken, createSignedToken, cookieHeader, jsonResponse, parseJSONSafely, logAction, checkRateLimit, recordRateLimit } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { const d = String(phone).replace(/\D/g, ''); return d.length >= 10 && d.length <= 12; }
function clean(s, max = 200) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }

// Helper: send verification email
async function sendVerificationEmail(to, name, url, env) {
  const html = `<h2>Hello ${name},</h2>
    <p>Thank you for registering at Kundasang Homestay.</p>
    <p>Please verify your email address by clicking the link below:</p>
    <p><a href="${url}" style="background:#0F382E;color:#fff;padding:10px 20px;border-radius:999px;text-decoration:none;">Verify Email</a></p>
    <p>This link expires in 24 hours.</p>
    <p>If you did not create an account, please ignore this email.</p>`;
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
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      console.error('❌ SESSION_SECRET is missing or too short');
      return jsonResponse(
        { error: 'Server configuration error. Please contact support.' },
        500,
        request
      );
    }

    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    // Rate limiting (5 attempts per 15 minutes per IP)
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

    // Check duplicate email
    if (guests.some(g => String(g.email || '').toLowerCase() === email)) {
      return jsonResponse({ error: 'Registration failed. Please try another email.' }, 400, request);
    }

    const hashed = await hashPassword(password, env);

    // ===== NEW GUEST with verified: false and sessionVersion =====
    const newGuest = {
      id: `G-${crypto.randomUUID()}`,
      name,
      email,
      phone,
      password: hashed.hash,
      salt: hashed.salt,
      passwordAlgorithm: hashed.algorithm,
      passwordVersion: 1,
      sessionVersion: 1,          // ← for session revocation
      createdAt: new Date().toISOString(),
      bookingsCount: 0,
      verified: false,            // ← email verification required
    };

    guests.push(newGuest);
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_guests', JSON.stringify(guests))
      .run();

    // ===== SEND VERIFICATION EMAIL =====
    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    const verifyToken = await createSignedToken({
      type: 'email_verification',
      userId: newGuest.id,
      email: newGuest.email
    }, env, 24 * 60 * 60 * 1000);
    const verifyUrl = `${domain}/api/verify-email?token=${encodeURIComponent(verifyToken)}`;
    const emailSent = await sendVerificationEmail(newGuest.email, newGuest.name, verifyUrl, env);
    if (!emailSent) {
      // Log but don't block registration – user can resend
      console.warn(`⚠️ Verification email failed to send for ${newGuest.email}`);
    }

    await logAction({
      db,
      action: 'guest_registered',
      admin: 'public',
      details: `Guest ${newGuest.id} registered (email: ${newGuest.email})`,
      ip: clientIP,
      userId: newGuest.id
    });

    // Record rate limit success (optional)
    await recordRateLimit(db, clientIP, 'register');

    // Generate session token and CSRF
    const session = await createSignedToken({
      type: 'guest',
      userId: String(newGuest.id),
      email: newGuest.email,
      passwordVersion: newGuest.passwordVersion,
      sessionVersion: newGuest.sessionVersion
    }, env);

    const csrfToken = await generateCSRFToken(newGuest.id, env);
    const { password: _, salt: __, ...safeGuest } = newGuest;

    return new Response(
      JSON.stringify({
        success: true,
        guest: safeGuest,
        token: session,
        csrfToken,
        message: 'Registration successful. Please check your email to verify your account.'
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders(request),
          'Set-Cookie': cookieHeader('guest_token', session)
        }
      }
    );

  } catch (e) {
    console.error('❌ Register error:', e.message, e.stack);
    return jsonResponse({ error: 'Registration failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
