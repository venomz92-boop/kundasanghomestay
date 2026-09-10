// /api/chip-webhook.js – RSASSA-PKCS1-v1_5 + SHA-256 + Refund + Idempotency
import { corsHeaders, getClientIP, logAction, withLock, finalizePaidBooking } from './_utils.js';

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
    console.error('CHIP_PUBLIC_KEY missing – webhook signature cannot be verified');
    return false;
  }

  const signature = request.headers.get('X-Signature');
  if (!signature) {
    console.warn('Missing X-Signature header');
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
    if (!valid) console.warn('Signature verification failed');
    return valid;
  } catch (e) {
    console.error('Signature verification error:', e.message);
    return false;
  }
}

async function sendCheckinEmail(booking, env) {
  const emailHtml = `
    <h2>Hello ${booking.guestName || 'Guest'},</h2>
    <p>Your booking at <strong>${booking.homestay}</strong> is confirmed!</p>
    <p><strong>Booking ID:</strong> ${booking.id}</p>
    <p><strong>Check-in:</strong> ${booking.checkin}</p>
    <p><strong>Check-out:</strong> ${booking.checkout}</p>
    <p><strong>Nights:</strong> ${booking.nights}</p>
    <p><strong>Total Paid:</strong> RM ${Number(booking.total).toFixed(2)}</p>
    <p style="font-size:20px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
      Your 6-digit check-in code: <span style="color:#0F382E;">${booking.checkinCode}</span>
    </p>
    <p><strong>Please keep this code safe.</strong> You will need to share it with the host when you arrive. Do not share it with anyone else.</p>
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

  return { emailSent, emailError };
}

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
      console.warn('Invalid CHIP webhook signature');
      return new Response('Invalid signature', { status: 401, headers: corsHeaders(request) });
    }

    const payload = await request.json();
    console.log('CHIP webhook received:', payload);

    const event = payload.event;
    const purchaseId = payload.data?.id;
    const status = payload.data?.status;

    if (!purchaseId || !event) {
      return new Response('Missing fields', { status: 400, headers: corsHeaders(request) });
    }

    const db = env.DB;
    if (!db) return new Response('DB error', { status: 500, headers: corsHeaders(request) });
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ============================================================
    // IDEMPOTENCY: dedupe events by event + purchaseId
    // ============================================================
    const eventKey = `${event}:${purchaseId}`;
    const eventsRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_webhook_events').first();
    let processedEvents = [];
    try { if (eventsRes?.data) processedEvents = JSON.parse(eventsRes.data); } catch (_) {}

    if (processedEvents.includes(eventKey)) {
      console.log(`Webhook event ${eventKey} already processed. Skipping.`);
      return new Response('OK', { status: 200, headers: corsHeaders(request) });
    }

    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => b.chip_purchase_id === purchaseId);
    if (idx === -1) {
      console.warn(`No booking found for purchase_id: ${purchaseId}`);
      return new Response('Booking not found', { status: 404, headers: corsHeaders(request) });
    }

    const booking = bookings[idx];

    // ===== PURCHASE PAID =====
    if (event === 'purchase.paid' || status === 'completed') {
      let finalizeResult;
      try {
        finalizeResult = await withLock(db, `paid-${booking.id}`, async (db) => {
          return await finalizePaidBooking(db, booking.id);
        }, 10000);
      } catch (lockErr) {
        // Another confirmation path is finalizing. Give it a moment and re-check.
        if (lockErr.message && lockErr.message.includes('in progress')) {
          await new Promise(r => setTimeout(r, 800));
          const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bb = [];
          try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
          const cur = bb.find(b => String(b.id) === String(booking.id));
          if (cur && (cur.status === 'Paid - Awaiting Check-in' || String(cur.status).startsWith('Completed'))) {
            finalizeResult = { alreadyFinalized: true, booking: cur, checkinCode: cur.checkinCode };
          } else {
            throw lockErr;
          }
        } else {
          throw lockErr;
        }
      }

      if (finalizeResult.error) {
        console.warn(`Finalize error: ${finalizeResult.error}`);
      } else if (finalizeResult.alreadyFinalized) {
        console.log(`Booking ${booking.id} already finalized by another path. Skipping email.`);
      } else if (finalizeResult.finalized) {
        // Only send email if we generated the code (avoid duplicates)
        if (finalizeResult.codeWasMissing) {
          const result = await sendCheckinEmail(finalizeResult.booking, env);
          if (result.emailSent) {
            console.log(`Check-in code email sent to ${booking.guestEmail}`);
          } else {
            console.warn(`Email failed: ${result.emailError}`);
          }
        } else {
          console.log(`Booking ${booking.id} finalized but code already existed — no email sent.`);
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
      }
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
      console.log(`Booking ${booking.id} marked as FAILED`);
    }

    // ===== PURCHASE REFUNDED =====
    else if (event === 'purchase.refunded' || status === 'refunded') {
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

      const result = await sendRefundEmail(bookings[idx], env);
      if (result.emailSent) {
        console.log(`Refund email sent to ${booking.guestEmail}`);
      } else {
        console.warn(`Refund email failed: ${result.emailError}`);
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

      console.log(`Booking ${booking.id} marked as REFUNDED (RM${refundedAmount.toFixed(2)})`);
    }

    // ============================================================
    // Record event as processed (only after successful handling)
    // ============================================================
    processedEvents.push(eventKey);
    if (processedEvents.length > 1000) {
      processedEvents = processedEvents.slice(-1000);
    }
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_webhook_events', JSON.stringify(processedEvents))
      .run();

    return new Response('OK', { status: 200, headers: corsHeaders(request) });

  } catch (e) {
    console.error('Webhook error:', e.message);
    return new Response('Internal server error', { status: 500, headers: corsHeaders(request) });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
