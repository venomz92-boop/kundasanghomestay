// /api/chip-webhook.js – RSASSA-PKCS1-v1_5 + SHA-256
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

// ===== EMAIL FUNCTION (copied from toyyibpay-webhook.js) =====
async function sendCheckinEmail(to, guestName, bookingId, checkinCode, homestayName, checkin, checkout, env) {
  const html = `
    <h2>Hello ${guestName || 'Guest'},</h2>
    <p>Your booking <strong>${bookingId}</strong> at <strong>${homestayName}</strong> has been paid successfully.</p>
    <p><strong>Check‑in:</strong> ${checkin}</p>
    <p><strong>Check‑out:</strong> ${checkout}</p>
    <p style="font-size:24px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
      🏔️ Your 6‑digit check‑in code: <span style="color:#0F382E;">${checkinCode}</span>
    </p>
    <p>Please present this code to the host upon arrival.</p>
    <p>Thank you for booking with Kundasang Homestay!</p>
  `;
  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: to,
          subject: 'Your Check‑in Code – Payment Confirmed',
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
          subject: 'Your Check‑in Code – Payment Confirmed',
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

      // Send email using the function from toyyibpay-webhook.js
      await sendCheckinEmail(
        booking.guestEmail,
        booking.guestName || 'Guest',
        booking.id,
        booking.checkinCode,
        booking.homestay || 'Kundasang Homestay',
        booking.checkin || 'N/A',
        booking.checkout || 'N/A',
        env
      );

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

    } else if (event === 'purchase.failed' || status === 'failed' || status === 'cancelled') {
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

    return new Response('OK', { status: 200, headers: corsHeaders(request) });

  } catch (e) {
    console.error('❌ Webhook error:', e.message);
    return new Response('Error: ' + e.message, { status: 500, headers: corsHeaders(request) });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
