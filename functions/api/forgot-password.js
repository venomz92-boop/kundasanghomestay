// /api/forgot-password.js
import { corsHeaders, getClientIP, jsonResponse, logAction, checkRateLimit, recordRateLimit } from './_utils.js';

async function generateResetToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

async function sendResetEmail(email, name, url, env) {
  const html = `<h2>Hello ${String(name || 'Guest').replace(/[<>]/g, '')}</h2><p>You requested a password reset for Kundasang Homestay.</p><p><a href="${url}">Reset your password</a></p><p>This link expires in 1 hour.</p><p>If you did not request this, ignore this email.</p>`;
  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: email,
          subject: 'Reset Your Password - Kundasang Homestay',
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
          subject: 'Reset Your Password - Kundasang Homestay',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return r.ok;
    }
  } catch (e) {
    console.error('Reset email error:', e.message);
  }
  return false;
}

export async function onRequestPost({ request, env }) {
  try {
    const { email, userType } = await request.json();
    const cleanEmail = String(email || '').toLowerCase().trim();
    if (!cleanEmail || !['guest', 'owner'].includes(userType)) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }

    const ip = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);

    const rateOk = await checkRateLimit(db, ip, 'forgot_password', 3, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many reset attempts. Please wait 15 minutes.' }, 429, request);
    }
    await recordRateLimit(db, ip, 'forgot_password');

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    let userId = null, userData = null;
    const read = async key => {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();
      try { return r?.data ? JSON.parse(r.data) : []; } catch (_) { return []; }
    };

    if (userType === 'guest') {
      const users = await read('kd_guests');
      const u = users.find(x => String(x.email || '').toLowerCase() === cleanEmail);
      if (u) { userId = u.id; userData = { name: u.name }; }
    } else {
      const homes = [...(await read('kd_approved')), ...(await read('kd_pending'))];
      const h = homes.find(x => String(x.ownerEmail || '').toLowerCase() === cleanEmail);
      if (h) { userId = h.id; userData = { name: h.ownerName }; }
    }

    if (!userId) {
      return jsonResponse({ success: true, message: 'If an account exists, a reset link has been sent.' }, 200, request);
    }

    await db.prepare(`CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_type TEXT NOT NULL,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0
    )`).run();

    const token = await generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.prepare(
      'INSERT OR REPLACE INTO password_resets (token, user_id, user_type, email, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)'
    ).bind(token, userId, userType, cleanEmail, expiresAt).run();

    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    const resetUrl = `${domain}/reset-password.html?token=${encodeURIComponent(token)}&type=${userType}`;

    const sent = await sendResetEmail(cleanEmail, userData?.name, resetUrl, env);
    if (!sent) {
      console.error(`Password reset email failed for ${cleanEmail}`);
    }

    return jsonResponse({ success: true, message: 'If an account exists, a reset link has been sent.' }, 200, request);
  } catch (e) {
    console.error('Forgot password error:', e.message, e.stack);
    return jsonResponse({ error: 'Unable to process request. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
