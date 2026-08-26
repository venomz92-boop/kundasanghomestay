// /api/register.js
import { corsHeaders, getClientIP, enforceHttps, hashPassword, generateCSRFToken, createSignedToken, cookieHeader, jsonResponse, parseJSONSafely, logAction, checkRateLimit, recordRateLimit } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { const d = String(phone).replace(/\D/g, ''); return d.length >= 10 && d.length <= 12; }
function clean(s, max = 200) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }

// Helper: send verification email via Resend
async function sendVerificationEmail(to, name, url, env) {
  const html = `<h2>Hello ${name},</h2>
    <p>Thank you for registering at Kundasang Homestay.</p>
    <p>Please verify your email address by clicking the link below:</p>
    <p><a href="${url}" style="background:#0F382E;color:#fff;padding:10px 20px;border-radius:999px;text-decoration:none;">Verify Email</a></p>
    <p>This link expires in 24 hours.</p>
    <p>If you did not create an account, please ignore this email.</p>`;

  const fromEmail = env.FROM_EMAIL || 'support@kundasanghomestay.my';

  // Check if Resend API key is set
  if (!env.RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY is not set. Please add it to your environment variables.');
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: to,
        subject: 'Verify Your Email - Kundasang Homestay',
        html: html
      })
    });

    const responseData = await response.json();

    if (response.ok) {
      console.log(`✅ Verification email sent to ${to} via Resend (ID: ${responseData.id})`);
      return true;
    } else {
      console.error(`❌ Resend API error (${response.status}):`, JSON.stringify(responseData));
      return false;
    }
  } catch (e) {
    console.error('❌ Email send error:', e.message);
    return false;
  }
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
      sessionVersion: 1,
      createdAt: new Date().toISOString(),
      bookingsCount: 0,
      verified: false,
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

    console.log(`📧 Attempting to send verification email to ${email}`);
    console.log(`🔗 Verification URL: ${verifyUrl}`);

    const emailSent = await sendVerificationEmail(newGuest.email, newGuest.name, verifyUrl, env);
    if (!emailSent) {
      console.error(`❌ Verification email failed for ${newGuest.email}. URL was: ${verifyUrl}`);
    }

    await logAction({
      db,
      action: 'guest_registered',
      admin: 'public',
      details: `Guest ${newGuest.id} registered (email: ${newGuest.email})`,
      ip: clientIP,
      userId: newGuest.id
    });

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

    // Response
    const responseData = {
      success: true,
      guest: safeGuest,
      token: session,
      csrfToken,
      message: emailSent 
        ? 'Registration successful. Please check your email to verify your account.'
        : 'Registration successful, but we could not send the verification email. Please contact support.'
    };

    // In non-production, include the verification URL for debugging
    const isProduction = env.ENVIRONMENT === 'production';
    if (!isProduction && !emailSent) {
      responseData.debugVerificationUrl = verifyUrl;
    }

    return new Response(
      JSON.stringify(responseData),
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
