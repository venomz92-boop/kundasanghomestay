// /api/chip-webhook.js – Fixed signature (RSASSA-PKCS1-v1_5 + SHA-256)
import { corsHeaders, getClientIP, logAction, jsonResponse } from './_utils.js';

// ===== Convert PEM to ArrayBuffer =====
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ===== Verify CHIP Collect webhook signature (RSASSA-PKCS1-v1_5 + SHA-256) =====
async function verifyChipSignature(request, env) {
  const publicKeyPem = env.CHIP_PUBLIC_KEY;
  if (!publicKeyPem) {
    console.error('❌ CHIP_PUBLIC_KEY missing');
    return false;
  }

  const signature = request.headers.get('X-Signature');
  if (!signature) return false;

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

    return await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      publicKey,
      sigBuffer,
      new TextEncoder().encode(body)
    );
  } catch (e) {
    console.error('❌ Signature verification error:', e.message);
    return false;
  }
}

export async function onRequestPost({ request, env }) {
  try {
    // 1. Verify signature
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

    // 2. Find booking by purchase_id
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => b.chip_purchase_id === purchaseId);
    if (idx === -1) {
      console.warn(`⚠️ No booking found for purchase_id: ${purchaseId}`);
      return new Response('Booking not found', { status: 404, headers: corsHeaders(request) });
    }

    const booking = bookings[idx];

    // 3. Process event
    if (event === 'purchase.paid' || status === 'completed') {
      if (booking.status === 'Paid - Awaiting Check-in') {
        console.log(`ℹ️ Booking ${booking.id} already paid. Skipping.`);
        return new Response('OK', { status: 200, headers: corsHeaders(request) });
      }

      // Generate checkinCode if missing
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

      // Send check-in code email (use your existing Resend/SendGrid logic)
      await sendCheckinEmail(booking, env);

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

// Helper – send check-in code email
async function sendCheckinEmail(booking, env) {
  const html = `
    <h2>Hello ${booking.guestName || 'Guest'},</h2>
    <p>Your booking <strong>${booking.id}</strong> at <strong>${booking.homestay}</strong> is paid.</p>
    <p><strong>Check‑in Code:</strong> <span style="font-size:24px;font-weight:bold;color:#0F382E;">${booking.checkinCode}</span></p>
    <p>Please present this code to the host upon arrival.</p>
  `;
  try {
    if (env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: booking.guestEmail,
          subject: 'Your Check‑in Code – Payment Confirmed',
          html
        })
      });
    }
  } catch (e) { console.error('Email send error:', e.message); }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
