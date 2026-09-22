// /api/resend-code.js – With CSRF + rate limiting + paid-only guard
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - validateCSRFToken now receives session.sessionVersion. Without
//   this the token's sv=1 was compared against a default of 0, so
//   every guest resend returned 403 Invalid security token after the
//   session-bound CSRF change shipped. (_middleware.js already
//   validates this same token; keeping the local check as
//   defense-in-depth, but it must use the same arguments.)
// - Uses parseJSONSafely (was request.json) so the 1MB guard applies.
// - Email fields escaped with escHtml (was a .replace(/[<>]/g,'')
//   helper that left & un-escaped).
// - Success response is now Cache-Control: no-store.
// - Error log no longer logs the raw error object.
import {
  corsHeaders,
  jsonResponse,
  getGuestSession,
  logAction,
  enforceHttps,
  getClientIP,
  checkRateLimit,
  recordRateLimit,
  validateCSRFToken,
  getCSRFToken,
  parseJSONSafely,
  escHtml
} from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session) return jsonResponse({ error: 'Unauthorized' }, 401, request);

    // ===== CSRF PROTECTION =====
    const csrf = getCSRFToken(request);
    const sessionSv = Number(session.sessionVersion ?? 0);
    if (!csrf || !(await validateCSRFToken(csrf, session.userId, env, sessionSv))) {
      return jsonResponse({ error: 'Invalid security token' }, 403, request);
    }

    let rawBody;
    try {
      rawBody = await parseJSONSafely(request);
    } catch (_) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }
    const { bookingId } = rawBody || {};
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);

    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId) && String(b.guestId) === String(session.userId));
    if (idx === -1) return jsonResponse({ error: 'Booking not found' }, 404, request);

    const booking = bookings[idx];

    // ===== PAID-ONLY GUARD =====
    const status = String(booking.status || '');
    const isPaid = status === 'Paid - Awaiting Check-in' ||
                   status.startsWith('Completed');
    if (!isPaid) {
      return jsonResponse({
        error: 'You can only request a check-in code for paid bookings. Please complete payment first.'
      }, 403, request);
    }

    // Rate limiting per booking (3 attempts per hour)
    const clientIP = getClientIP(request);
    const actionKey = `resend_${bookingId}`;
    const rateOk = await checkRateLimit(db, clientIP, actionKey, 3, 3600);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many resend attempts. Please wait an hour.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, actionKey);

    if (!booking.checkinCode) {
      console.error(`Paid booking ${bookingId} has no checkinCode – this indicates a finalization bug`);
      return jsonResponse({
        error: 'Your check-in code is not available yet. Please contact support.'
      }, 500, request);
    }

    const code = booking.checkinCode;

    const resendNights = Number(booking.nights) || 1;
    const resendNightLabel = resendNights === 1 ? 'night' : 'nights';
    const resendTotal = Number(booking.total || 0);

    const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>Your Check-in Code</title>
</head>
<body style="margin:0;padding:0;background-color:#f8f5f0;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8f5f0;">
  <tr>
    <td align="center" style="padding:24px 16px;">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;border:1px solid #e5e7eb;">

        <tr>
          <td style="padding:36px 32px 28px 32px;">

            <div style="text-align:center;padding-bottom:20px;border-bottom:2px solid #0F382E;">
              <div style="font-size:22px;font-weight:800;color:#0F382E;letter-spacing:-0.3px;line-height:1.2;">Kundasang Homestay</div>
              <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:2px;margin-top:6px;">Your Check-in Code</div>
            </div>

            <p style="font-size:14px;color:#212121;line-height:1.6;margin-top:24px;margin-bottom:16px;">
              Hello ${escHtml(booking.guestName) || 'Guest'},
            </p>
            <p style="font-size:14px;color:#4b5563;line-height:1.6;margin:0 0 24px 0;">
              Here is your check-in code for <strong style="color:#212121;">${escHtml(booking.homestay)}</strong>.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8f5f0;border-radius:12px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;width:100px;">Booking ID</td>
                      <td style="padding:5px 0;font-size:13px;color:#212121;font-weight:700;font-family:'Courier New',monospace;">${escHtml(booking.id)}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;">Check-in</td>
                      <td style="padding:5px 0;font-size:13px;color:#212121;font-weight:600;">${escHtml(booking.checkin)}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;">Check-out</td>
                      <td style="padding:5px 0;font-size:13px;color:#212121;font-weight:600;">${escHtml(booking.checkout)}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;">Nights</td>
                      <td style="padding:5px 0;font-size:13px;color:#212121;font-weight:600;">${resendNights} ${resendNightLabel}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;">Total Paid</td>
                      <td style="padding:5px 0;font-size:13px;color:#0F382E;font-weight:700;font-family:'Courier New',monospace;">RM ${resendTotal.toFixed(2)}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;">
              <tr>
                <td style="background-color:#f0fdf4;border:2px solid #86efac;border-radius:14px;padding:24px 20px;text-align:center;">
                  <div style="font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Your Check-in Code</div>
                  <div style="font-family:'Courier New',Consolas,monospace;font-size:38px;font-weight:800;color:#0F382E;letter-spacing:10px;line-height:1;padding-left:10px;">${escHtml(code)}</div>
                  <div style="font-size:12px;color:#166534;margin-top:16px;line-height:1.6;">Share this 6-digit code with the host when you arrive.<br>Do not share it with anyone else.</div>
                </td>
              </tr>
            </table>

            <div style="text-align:center;font-size:11px;color:#9ca3af;margin-top:32px;padding-top:20px;border-top:1px solid #e5e7eb;line-height:1.7;">
              Payment processed via CHIP FPX<br>
              &copy; ${new Date().getFullYear()} Kundasang Homestay
            </div>

          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>
</body>
</html>`;

    let emailSent = false;
    let emailError = null;

    if (env.RESEND_API_KEY) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
            to: booking.guestEmail,
            subject: 'Your Check-in Code',
            html: emailHtml
          })
        });
        emailSent = res.ok;
        if (!emailSent) emailError = 'Resend API error';
      } catch (e) {
        emailError = e.message;
      }
    } else if (env.SENDGRID_API_KEY) {
      try {
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: booking.guestEmail }] }],
            from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
            subject: 'Your Check-in Code',
            content: [{ type: 'text/html', value: emailHtml }]
          })
        });
        emailSent = res.ok;
        if (!emailSent) emailError = 'SendGrid API error';
      } catch (e) {
        emailError = e.message;
      }
    } else {
      emailError = 'No email API key configured';
    }

    await logAction({
      db,
      action: 'code_resent',
      admin: 'guest',
      details: `Resent code for ${bookingId} (email sent: ${emailSent})`,
      ip: getClientIP(request),
      userId: session.userId
    });

    return jsonResponse({
      success: true,
      emailSent: emailSent,
      message: emailSent
        ? 'Check-in code resent to your email.'
        : `Failed to send email: ${emailError || 'unknown error'}. Please contact support.`
    }, 200, request, { 'Cache-Control': 'no-store' });

  } catch (e) {
    console.error('Resend code error:', e.message);
    return jsonResponse({ error: 'Failed to resend: ' + e.message }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
