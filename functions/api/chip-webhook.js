// /api/chip-webhook.js – RSASSA-PKCS1-v1_5 + SHA-256 + Refund handling
import { corsHeaders, getClientIP, logAction } from './_utils.js';

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function verifyChipSignature(request, env) {
  const publicKeyPem = env.CHIP_PUBLIC_KEY;
  if (!publicKeyPem) {
    console.error('❌ CHIP_PUBLIC_KEY missing – webhook signature cannot be verified');
    return false;
  }

  const signature = request.headers.get('X-Signature');
  if (!signature) {
    console.warn('⚠️ Missing X-Signature header');
    return false;
  }

  const body = await request.clone().text();

  try {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      pemToArrayBuffer(publicKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBuffer = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      publicKey,
      sigBuffer,
      new TextEncoder().encode(body)
    );
    if (!valid) console.warn('⚠️ Signature verification failed');
    return valid;
  } catch (e) {
    console.error('Signature verification error:', e.message);
    return false;
  }
}

// ===== EMAIL FUNCTION (EXACT COPY from resend-code.js) =====
async function sendCheckinEmail(booking, env) {
  const emailHtml = `
    <h2>Hello ${booking.guestName || 'Guest'},</h2>
    <p>Your booking at <strong>${booking.homestay}</strong> is confirmed!</p>
    <p><strong>Booking ID:</strong> ${booking.id}</p>
    <p><strong>Check‑in:</strong> ${booking.checkin}</p>
    <p><strong>Check‑out:</strong> ${booking.checkout}</p>
    <p><strong>Nights:</strong> ${booking.nights}</p>
    <p><strong>Total Paid:</strong> RM ${Number(booking.total).toFixed(2)}</p>
    <p style="font-size:20px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
      🏔️ Your 6‑digit check‑in code: <span style="color:#0F382E;">${booking.checkinCode}</span>
    </p>
    <p><strong>Please keep this code safe.</strong> You will need to share it with the host when you arrive. Do not share it with anyone else.</p>
    <p>— Kundasang Homestay Team</p>
  `;

  let emailSent = false;
  let emailError = null;

  // Try Resend
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: booking.guestEmail,
          subject: 'Your Check‑in Code',
          html: emailHtml
        })
      });
      emailSent = res.ok;
      if (!emailSent) emailError = 'Resend API error';
    } catch (e) {
      emailError = e.message;
    }
  } 
  // Try SendGrid
  else if (env.SENDGRID_API_KEY) {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: booking.guestEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Your Check‑in Code',
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

  return { emailSent, emailError };
}

// ===== NEW: Refund email notification to guest =====
async function sendRefundEmail(booking, env) {
  const refundAmount = booking.refund_amount || booking.total || 0;
  const refundId = booking.chip_refund_id || 'N/A';
  const emailHtml = `
    <h2>Hello ${booking.guestName || 'Guest'},</h2>
    <p>Your booking <strong>${booking.id}</strong> at <strong>${booking.homestay}</strong> has been <strong>cancelled and refunded</strong>.</p>
    <p><strong>Refund Amount:</strong> RM ${Number(refundAmount).toFixed(2)}</p>
    <p><strong>Refund ID (CHIP):</strong> ${refundId}</p>
    <p>If you have any questions, please contact the host or our support team.</p>
    <p>— Kundasang Homestay Team</p>
  `;

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
          subject: 'Refund Confirmation – Booking ' + booking.id,
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
          subject: 'Refund Confirmation – Booking ' + booking.id,
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

  return { emailSent, emailError };
}

export async function onRequestPost({ request, env }) {
  try {
    const isValid = await verifyChipSignature(request, env);
    if (!isValid) {
      console.warn('❌ Invalid CHIP webhook signature');
      return new Response('Invalid signature', { status: 401, headers: corsHeaders(request) });
    }

    const payload = await request.json();
    console.log('✅ CHIP webhook received:', payload);

    const event = payload.event;
    const purchaseId = payload.data?.id;
    const status = payload.data?.status;

    if (!purchaseId || !event) {
      return new Response('Missing fields', { status: 400, headers: corsHeaders(request) });
    }

    const db = env.DB;
    if (!db) return new Response('DB error', { status: 500, headers: corsHeaders(request) });

    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => b.chip_purchase_id === purchaseId);
    if (idx === -1) {
      console.warn(`⚠️ No booking found for purchase_id: ${purchaseId}`);
      return new Response('Booking not found', { status: 404, headers: corsHeaders(request) });
    }

    const booking = bookings[idx];

    // ===== PURCHASE PAID =====
    if (event === 'purchase.paid' || status === 'completed') {
      if (booking.status === 'Paid - Awaiting Check-in') {
        console.log(`ℹ️ Booking ${booking.id} already paid. Skipping.`);
        return new Response('OK', { status: 200, headers: corsHeaders(request) });
      }

      if (!booking.checkinCode) {
        booking.checkinCode = Math.floor(100000 + Math.random() * 900000).toString();
      }

      bookings[idx] = {
        ...booking,
        status: 'Paid - Awaiting Check-in',
        paid_at: new Date().toISOString(),
        chip_status: 'paid',
        chip_paid_at: new Date().toISOString()
      };

      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      const result = await sendCheckinEmail(bookings[idx], env);
      if (result.emailSent) {
        console.log(`✅ Check‑in code email sent to ${booking.guestEmail}`);
      } else {
        console.warn(`⚠️ Email failed: ${result.emailError}`);
      }

      await logAction({
        db,
        action: 'chip_payment_success',
        admin: 'webhook',
        details: `Booking ${booking.id} paid via CHIP`,
        ip: getClientIP(request),
        userId: booking.guestId,
        homestayId: booking.homestayId
      });

      console.log(`✅ Booking ${booking.id} marked as PAID`);
    }

    // ===== PURCHASE FAILED =====
    else if (event === 'purchase.failed' || status === 'failed' || status === 'cancelled') {
      bookings[idx] = {
        ...booking,
        status: 'Payment Failed',
        chip_status: 'failed'
      };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
      console.log(`⚠️ Booking ${booking.id} marked as FAILED`);
    }

    // ===== NEW: PURCHASE REFUNDED =====
    else if (event === 'purchase.refunded' || status === 'refunded') {
      // Calculate refund amount from webhook payload if available
      const refundedAmount = payload.data?.refunded_amount 
        ? Number(payload.data.refunded_amount) / 100 
        : booking.total || 0;

      bookings[idx] = {
        ...booking,
        status: 'Refunded',
        chip_status: 'refunded',
        refunded_at: new Date().toISOString(),
        refund_amount: refundedAmount,
        chip_refund_id: payload.data?.refund_id || payload.data?.id || 'webhook_refund'
      };

      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      // Send refund confirmation email
      const result = await sendRefundEmail(bookings[idx], env);
      if (result.emailSent) {
        console.log(`✅ Refund email sent to ${booking.guestEmail}`);
      } else {
        console.warn(`⚠️ Refund email failed: ${result.emailError}`);
      }

      await logAction({
        db,
        action: 'chip_refund_success',
        admin: 'webhook',
        details: `Booking ${booking.id} refunded via CHIP (${refundedAmount})`,
        ip: getClientIP(request),
        userId: booking.guestId,
        homestayId: booking.homestayId
      });

      console.log(`✅ Booking ${booking.id} marked as REFUNDED (RM${refundedAmount.toFixed(2)})`);
    }

    return new Response('OK', { status: 200, headers: corsHeaders(request) });

  } catch (e) {
    console.error('❌ Webhook error:', e.message);
    return new Response('Error: ' + e.message, { status: 500, headers: corsHeaders(request) });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
