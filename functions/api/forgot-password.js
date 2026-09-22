// /api/forgot-password.js
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - Uses parseJSONSafely (was request.json) so the 1MB body-size
//   guard applies.
// - Reset email escapes the recipient's name with escHtml (was an
//   incomplete .replace(/[<>]/g,''), which left & un-escaped).
// - Added a global rate limit alongside the per-IP one.
// - Success response is now Cache-Control: no-store.
// - Error log no longer includes the stack trace.
//
// NOT changed (intentional):
// - The response is identical whether the account exists or not
//   (no enumeration leak).
// - userType is scoped: guest lookup can't find owners and vice versa.
// - Rate limit is 3 per 15 min per IP.
// - Tokens expire in 1h and expired rows are cleaned up.
//
// TODO (Phase 4): store the reset token hashed rather than plaintext.
// Requires a one-time purge of password_resets to keep old tokens
// invalid, so it's a dedicated change.
import {
  corsHeaders,
  getClientIP,
  enforceHttps,
  jsonResponse,
  logAction,
  checkRateLimit,
  recordRateLimit,
  parseJSONSafely,
  escHtml
} from './_utils.js';

const IP_LIMIT = 3;
const IP_WINDOW_SECONDS = 15 * 60;
const GLOBAL_KEY = '__forgot_password_global__';
const GLOBAL_LIMIT = 30;
const GLOBAL_WINDOW_SECONDS = 15 * 60;

async function generateResetToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

async function sendResetEmail(email, name, url, env) {
  const safeName = escHtml(name || 'Guest');
  const safeUrl = escHtml(url);
  const html = `<h2>Hello ${safeName}</h2><p>You requested a password reset for Kundasang Homestay.</p><p><a href="${safeUrl}">Reset your password</a></p><p>This link expires in 1 hour.</p><p>If you did not request this, ignore this email.</p>`;
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
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    if (!env.RESEND_API_KEY && !env.SENDGRID_API_KEY) {
      console.error('CRITICAL: No email provider configured. Password resets will not send.');
      return jsonResponse(
        { error: 'Email service is temporarily unavailable. Please contact support@kundasanghomestay.my' },
        503,
        request
      );
    }

    let rawBody;
    try {
      rawBody = await parseJSONSafely(request);
    } catch (_) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }

    const { email, userType } = rawBody || {};
    const cleanEmail = String(email || '').toLowerCase().trim();
    if (!cleanEmail || !['guest', 'owner'].includes(userType)) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }

    const ip = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);

    // Per-IP limit
    const ipOk = await checkRateLimit(db, ip, 'forgot_password', IP_LIMIT, IP_WINDOW_SECONDS);
    if (!ipOk) {
      return jsonResponse({ error: 'Too many reset attempts. Please wait 15 minutes.' }, 429, request);
    }
    // Global limit
    const globalOk = await checkRateLimit(db, GLOBAL_KEY, 'forgot_password', GLOBAL_LIMIT, GLOBAL_WINDOW_SECONDS);
    if (!globalOk) {
      return jsonResponse({ error: 'Too many reset attempts. Please wait 15 minutes.' }, 429, request);
    }
    await recordRateLimit(db, ip, 'forgot_password');
    await recordRateLimit(db, GLOBAL_KEY, 'forgot_password');

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    await db.prepare(
      `CREATE TABLE IF NOT EXISTS password_resets (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_type TEXT NOT NULL,
        email TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0
      )`
    ).run();
    await db.prepare(
      `DELETE FROM password_resets WHERE expires_at < datetime('now', '-24 hours')`
    ).run();

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
      const owners = await read('kd_owners');
      const acc = owners.find(o => String(o.ownerEmail || '').toLowerCase() === cleanEmail);
      if (acc) {
        userId = acc.id;
        userData = { name: acc.ownerName };
      } else {
        const homes = [...(await read('kd_approved')), ...(await read('kd_pending'))];
        const h = homes.find(x => String(x.ownerEmail || '').toLowerCase() === cleanEmail);
        if (h) { userId = h.id; userData = { name: h.ownerName }; }
      }
    }

    if (!userId) {
      return jsonResponse({ success: true, message: 'If an account exists, a reset link has been sent.' }, 200, request, { 'Cache-Control': 'no-store' });
    }

    const token = await generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.prepare(
      'INSERT OR REPLACE INTO password_resets (token, user_id, user_type, email, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)'
    ).bind(token, userId, userType, cleanEmail, expiresAt).run();

    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    const resetUrl = `${domain}/forgot-password.html?token=${encodeURIComponent(token)}&type=${userType}`;

    const sent = await sendResetEmail(cleanEmail, userData?.name, resetUrl, env);
    if (!sent) {
      console.error(`Password reset email failed for ${cleanEmail}`);
    }

    return jsonResponse({ success: true, message: 'If an account exists, a reset link has been sent.' }, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('Forgot password error:', e.message);
    return jsonResponse({ error: 'Unable to process request. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
