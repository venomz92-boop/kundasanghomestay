// /api/register.js
import { corsHeaders, getClientIP, enforceHttps, hashPassword, generateCSRFToken, createSignedToken, cookieHeader, jsonResponse } from './_utils.js';

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePhone(phone) { const d = String(phone).replace(/\D/g, ''); return d.length >= 10 && d.length <= 12; }
function clean(s, max = 200) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, max); }

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // ----- Check required secrets early -----
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      console.error('❌ SESSION_SECRET is missing or too short');
      return jsonResponse(
        { error: 'Server configuration error: SESSION_SECRET is missing or too short. Please set it in Cloudflare Pages environment variables.' },
        500,
        request
      );
    }
    // PASSWORD_PEPPER is optional – it falls back to SESSION_SECRET in _utils.js

    let { name, email, phone, password } = await request.json();
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

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error: DB binding missing' }, 500, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}

    if (guests.some(g => String(g.email || '').toLowerCase() === email)) {
      return jsonResponse({ error: 'Registration failed. Please try another email.' }, 400, request);
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
      createdAt: new Date().toISOString(),
      bookingsCount: 0,
      verified: false
    };

    guests.push(newGuest);
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_guests', JSON.stringify(guests))
      .run();

    const { password: _, salt: __, ...safeGuest } = newGuest;
    const token = await createSignedToken({ type: 'guest', userId: String(newGuest.id), email: newGuest.email }, env);
    const csrfToken = await generateCSRFToken(newGuest.id, env);

    return new Response(
      JSON.stringify({
        success: true,
        guest: safeGuest,
        token,
        csrfToken,
        message: 'Registration successful'
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders(request),
          'Set-Cookie': cookieHeader('guest_token', token)
        }
      }
    );
  } catch (e) {
    console.error('❌ Register error:', e.message, e.stack);
    // Return the actual error message for easier debugging
    return jsonResponse(
      { error: 'Registration failed: ' + e.message },
      500,
      request
    );
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
