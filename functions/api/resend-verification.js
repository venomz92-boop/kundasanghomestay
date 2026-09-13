// /api/resend-verification.js
import {
  corsHeaders,
  enforceHttps,
  jsonResponse,
  getGuestSession,
  createSignedToken,
  getClientIP,
  logAction,
  checkRateLimit,
  recordRateLimit
} from './_utils.js';

async function sendVerificationEmail(to, name, url, env) {
  const html = `<h2>Hello ${name},</h2><p>Please verify your email address for Kundasang Homestay.</p><p><a href="${url}">Verify Email</a></p><p>This link expires in 24 hours.</p>`;
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
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // [SECURITY] Rate-limit per IP to stop an authenticated guest from
    // spamming unlimited verification emails.
    const clientIP = getClientIP(request);
    const rateOk = await checkRateLimit(db, clientIP, 'resend_verification', 5, 60 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many verification emails requested. Please wait an hour.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, 'resend_verification');

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    if (r?.data) { try { guests = JSON.parse(r.data); } catch(_) {} }
    const guest = guests.find(g => String(g.id) === String(session.userId));
    if (!guest) return jsonResponse({ error: 'User not found' }, 404, request);

    if (guest.verified === true) {
      return jsonResponse({ message: 'Email already verified' }, 200, request);
    }

    // Generate new token
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

    return jsonResponse({ success: true, message: 'Verification email sent' }, 200, request);
  } catch (e) {
    console.error('Resend verification error:', e);
    return jsonResponse({ error: 'Failed to resend verification' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
