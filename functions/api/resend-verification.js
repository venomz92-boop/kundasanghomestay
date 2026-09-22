// /api/resend-verification.js
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - Verification email now escapes the guest's name and the verify
//   URL with escHtml.
// - Added a global rate limit alongside the per-IP one.
// - Success response is now Cache-Control: no-store.
// - Error log no longer includes the stack trace.
import {
  corsHeaders,
  enforceHttps,
  jsonResponse,
  getGuestSession,
  createSignedToken,
  getClientIP,
  logAction,
  checkRateLimit,
  recordRateLimit,
  escHtml
} from './_utils.js';

const IP_LIMIT = 5;
const IP_WINDOW_SECONDS = 60 * 60;
const GLOBAL_KEY = '__resend_verification_global__';
const GLOBAL_LIMIT = 60;
const GLOBAL_WINDOW_SECONDS = 60 * 60;

async function sendVerificationEmail(to, name, url, env) {
  const safeName = escHtml(name || 'Guest');
  const safeUrl = escHtml(url);
  const html = `<h2>Hello ${safeName},</h2><p>Please verify your email address for Kundasang Homestay.</p><p><a href="${safeUrl}">Verify Email</a></p><p>This link expires in 24 hours.</p>`;
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
    console.error('Email send error:', e.message);
  }
  return false;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const clientIP = getClientIP(request);

    const ipOk = await checkRateLimit(db, clientIP, 'resend_verification', IP_LIMIT, IP_WINDOW_SECONDS);
    if (!ipOk) {
      return jsonResponse({ error: 'Too many verification emails requested. Please wait an hour.' }, 429, request);
    }
    const globalOk = await checkRateLimit(db, GLOBAL_KEY, 'resend_verification', GLOBAL_LIMIT, GLOBAL_WINDOW_SECONDS);
    if (!globalOk) {
      return jsonResponse({ error: 'Too many verification emails requested. Please wait an hour.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, 'resend_verification');
    await recordRateLimit(db, GLOBAL_KEY, 'resend_verification');

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    if (r?.data) { try { guests = JSON.parse(r.data); } catch(_) {} }
    const guest = guests.find(g => String(g.id) === String(session.userId));
    if (!guest) return jsonResponse({ error: 'User not found' }, 404, request);

    if (guest.verified === true) {
      return jsonResponse({ message: 'Email already verified' }, 200, request, { 'Cache-Control': 'no-store' });
    }

    const token = await createSignedToken({
      type: 'email_verification',
      userId: guest.id,
      email: guest.email
    }, env, 24 * 60 * 60 * 1000);

    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    const verifyUrl = `${domain}/api/verify-email?token=${encodeURIComponent(token)}`;

    const emailSent = await sendVerificationEmail(guest.email, guest.name, verifyUrl, env);
    if (!emailSent) {
      return jsonResponse({ error: 'Failed to send verification email' }, 500, request);
    }

    await logAction({
      db,
      action: 'verification_resent',
      admin: 'guest',
      details: `Resent verification to ${guest.email}`,
      ip: clientIP,
      userId: guest.id
    });

    return jsonResponse({ success: true, message: 'Verification email sent' }, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('Resend verification error:', e.message);
    return jsonResponse({ error: 'Failed to resend verification' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
