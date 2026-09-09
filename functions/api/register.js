// /api/register.js
import { corsHeaders, getClientIP, enforceHttps, hashPassword, createSignedToken, jsonResponse, parseJSONSafely, logAction, checkRateLimit, recordRateLimit } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { const d = String(phone).replace(/\D/g, ''); return d.length >= 10 && d.length <= 12; }
function clean(s, max = 200) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }

// ===== Send verification email =====
async function sendVerificationEmail(email, name, url, env) {
  const html = `<h2>Hello ${String(name || 'Guest').replace(/[<>]/g, '')}</h2>
    <p>Thank you for registering at Kundasang Homestay.</p>
    <p>Please verify your email address by clicking the link below:</p>
    <p><a href="${url}">Verify Email</a></p>
    <p>This link expires in 24 hours.</p>
    <p>If you did not create an account, please ignore this email.</p>`;

  try {
    if (env.RESEND_API_KEY) {
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
      const data = await r.json();
      if (r.ok) {
        // console.log(`✅ Verification email sent to ${email} (ID: ${data.id})`);
        return true;
      } else {
        // console.error(`❌ Resend error:`, data);
        return false;
      }
    }
  } catch (e) {
    // console.error('Email send error:', e.message);
    return false;
  }
  return false;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      // console.error('❌ SESSION_SECRET is missing or too short');
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

    // ---- FIX: Remove specific duplicate email error ----
    // Instead of checking and returning specific error, we'll just let the save proceed.
    // If we want to prevent duplicates, we'll check and return a generic error.
    // We'll still check but return generic.
    const exists = guests.some(g => String(g.email || '').toLowerCase() === email);
    if (exists) {
      // Generic error – do not disclose existence
      return jsonResponse({ error: 'Registration failed. Please check your details or try again.' }, 400, request);
    }

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

    // ===== SEND VERIFICATION EMAIL =====
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
      details: `Guest ${newGuest.id} registered (email: ${newGuest.email})`,
      ip: clientIP,
      userId: newGuest.id
    });

    await recordRateLimit(db, clientIP, 'register');

    // ---- NO AUTO-LOGIN ----
    const { password: _, salt: __, ...safeGuest } = newGuest;

    const responseData = {
      success: true,
      guest: safeGuest,
      message: emailSent 
        ? 'Registration successful. Please check your email to verify your account before logging in.'
        : 'Registration successful, but verification email could not be sent. Please contact support.',
    };

    return new Response(
      JSON.stringify(responseData),
      {
        status: 200,
        headers: {
          ...corsHeaders(request)
          // No Set-Cookie header
        }
      }
    );

  } catch (e) {
    // console.error('❌ Register error:', e.message, e.stack);
    return jsonResponse({ error: 'Registration failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
