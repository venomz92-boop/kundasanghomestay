// /api/chip-webhook.js — Plain English: this is the file CHIP calls when
// a payment succeeds, fails, or is refunded. Two big changes:
// (1) Duplicate events are now tracked in a real database table with an
//     automatic 30-day cleanup — before this, we kept them in a JSON blob
//     capped at 1000 entries, which could forget old events and re-run
//     them. Now every event is recorded exactly once.
// (2) This file now uses the same shared "bookings-global" lock as every
//     other booking file, so it can never race with the guest payment
//     check, the host dashboard, or an admin edit.
//
// [THIS REVISION]
// (3) When finalizePaidBooking returns an error, we now return HTTP 500
//     and roll back the dedup row, so CHIP retries the event. Previously
//     we logged a warning and returned 200, which told CHIP "handled,
//     do not retry" and left the booking pending forever.
// (4) Every refund calculation now uses `amount_paid` (the amount CHIP
//     actually collected) instead of `total` (which can be recalculated
//     by an admin editing dates on a paid booking).
// (5) The check-in code email sent by this webhook was rewritten to
//     match the receipt email in verify-payment.js: light-mode locked
//     (no dark-mode inversion), table-based layout, big monospace code
//     hero, correct pluralisation. This is the path 90% of guests
//     actually see, because CHIP fires the webhook the moment payment
//     settles — usually before the guest's browser finishes the return
//     redirect.
import { corsHeaders, getClientIP, logAction, withLock, finalizePaidBooking } from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';
const WEBHOOK_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

// M2: dedicated D1 table for dedup, replacing the capped JSON blob.
async function ensureWebhookEventsTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS webhook_events (
      event_key TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    )`
  ).run();
}

// Auto-refund helper. CALLER MUST HOLD BOOKINGS_LOCK (C4).
async function tryAutoRefundLatePaymentLocked(db, bookingId, env) {
  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
  const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
  if (idx === -1) return { error: 'Booking not found' };
  const b = bookings[idx];

  if (b.chip_refund_id) {
    return { alreadyRefunded: true, refundId: b.chip_refund_id };
  }
  if (!b.chip_purchase_id) {
    return { error: 'No chip_purchase_id to refund' };
  }

  const secret = env.CHIP_SECRET_KEY;
  if (!secret) return { error: 'CHIP_SECRET_KEY missing' };

  // Refund the amount CHIP actually collected.
  const refundAmountCents = Math.round(Number(b.amount_paid || b.total) * 100);

  try {
    const res = await fetch(
      `https://gate.chip-in.asia/api/v1/purchases/${b.chip_purchase_id}/refund/`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secret}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ amount: refundAmountCents })
      }
    );
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }

    if (!res.ok || !data || !data.id) {
      return { error: `CHIP refund failed: ${data?.error || 'unknown'}` };
    }

    const isPending = data.status === 'pending_refund';

    bookings[idx].status = isPending ? 'Refund Pending - Awaiting CHIP' : 'Refunded - Late Payment';
    bookings[idx].chip_refund_id = data.id;
    bookings[idx].refunded_at = new Date().toISOString();
    bookings[idx].refund_amount = Number(b.amount_paid || b.total) || 0;
    bookings[idx].late_payment_refund = true;
    if (isPending) bookings[idx].refund_pending = true;

    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    return { success: true, refundId: data.id, pending: isPending };
  } catch (e) {
    return { error: `Refund network error: ${e.message}` };
  }
}

// ============================================================
// Check-in code email — sent by the webhook when a payment is confirmed.
//
// [THIS REVISION]
// Full cosmetic overhaul, matching the receipt email in verify-payment.js:
//   - Forces light-mode rendering via color-scheme meta tags so Apple
//     Mail / Gmail dark mode cannot invert the brand colors.
//   - Table-based layout for maximum email client compatibility.
//   - Check-in code is now the visual hero — large, monospace, in its
//     own highlighted box.
//   - Fixed pluralisation: "1 nights" → "1 night".
// ============================================================
async function sendCheckinEmail(booking, env) {
  const nights = Number(booking.nights) || 1;
  const nightLabel = nights === 1 ? 'night' : 'nights';
  const safe = (s) => String(s || '').replace(/[<>]/g, '');
  const total = Number(booking.total || 0);

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

            <!-- Header -->
            <div style="text-align:center;padding-bottom:20px;border-bottom:2px solid #0F382E;">
              <div style="font-size:22px;font-weight:800;color:#0F382E;letter-spacing:-0.3px;line-height:1.2;">Kundasang Homestay</div>
              <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:2px;margin-top:6px;">Booking Confirmed</div>
            </div>

            <!-- Greeting -->
            <p style="font-size:14px;color:#212121;line-height:1.6;margin-top:24px;margin-bottom:16px;">
              Hello ${safe(booking.guestName) || 'Guest'},
            </p>
            <p style="font-size:14px;color:#4b5563;line-height:1.6;margin:0 0 24px 0;">
              Your booking at <strong style="color:#212121;">${safe(booking.homestay)}</strong> is confirmed and paid.
            </p>

            <!-- Booking summary -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8f5f0;border-radius:12px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;width:100px;">Booking ID</td>
                      <td style="padding:5px 0;font-size:13px;color:#212121;font-weight:700;font-family:'Courier New',monospace;">${safe(booking.id)}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;">Check-in</td>
                      <td style="padding:5px 0;font-size:13px;color:#212121;font-weight:600;">${safe(booking.checkin)}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;">Check-out</td>
                      <td style="padding:5px 0;font-size:13px;color:#212121;font-weight:600;">${safe(booking.checkout)}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;">Nights</td>
                      <td style="padding:5px 0;font-size:13px;color:#212121;font-weight:600;">${nights} ${nightLabel}</td>
                    </tr>
                    <tr>
                      <td style="padding:5px 0;font-size:12px;color:#6b7280;">Total Paid</td>
                      <td style="padding:5px 0;font-size:13px;color:#0F382E;font-weight:700;font-family:'Courier New',monospace;">RM ${total.toFixed(2)}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Check-in code — the visual hero -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;">
              <tr>
                <td style="background-color:#f0fdf4;border:2px solid #86efac;border-radius:14px;padding:24px 20px;text-align:center;">
                  <div style="font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Your Check-in Code</div>
                  <div style="font-family:'Courier New',Consolas,monospace;font-size:38px;font-weight:800;color:#0F382E;letter-spacing:10px;line-height:1;padding-left:10px;">${safe(booking.checkinCode)}</div>
                  <div style="font-size:12px;color:#166534;margin-top:16px;line-height:1.6;">Share this 6-digit code with the host when you arrive.<br>Do not share it with anyone else.</div>
                </td>
              </tr>
            </table>

            <!-- Footer -->
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

  return { emailSent, emailError };
}

async function sendRefundEmail(booking, env) {
  const refundAmount = booking.refund_amount || booking.amount_paid || booking.total || 0;
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
  let eventKey = null;
  let db = null;

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

    db = env.DB;
    if (!db) return new Response('DB error', { status: 500, headers: corsHeaders(request) });
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    await ensureWebhookEventsTable(db);

    // ============================================================
    // M2: dedup via dedicated D1 table using INSERT OR IGNORE.
    // Row is rolled back on handler failure (see catch below) so
    // CHIP's automatic retry re-processes cleanly.
    // ============================================================
    eventKey = `${event}:${purchaseId}`;
    const now = Date.now();

    const insertRes = await db.prepare(
      `INSERT OR IGNORE INTO webhook_events (event_key, processed_at) VALUES (?, ?)`
    ).bind(eventKey, now).run();

    if (!insertRes.meta || insertRes.meta.changes === 0) {
      console.log(`Webhook event ${eventKey} already processed. Skipping.`);
      return new Response('OK', { status: 200, headers: corsHeaders(request) });
    }

    // Prune stale rows (cheap DELETE; runs on every webhook).
    try {
      const cutoff = now - WEBHOOK_EVENT_TTL_MS;
      await db.prepare(`DELETE FROM webhook_events WHERE processed_at < ?`).bind(cutoff).run();
    } catch (_) { /* best-effort */ }

    // ============================================================
    // Find the booking for this purchase.
    // ============================================================
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => b.chip_purchase_id === purchaseId);
    if (idx === -1) {
      console.warn(`No booking found for purchase_id: ${purchaseId}`);
      // Roll back dedup row so a retry can try again after the
      // booking is created (rare race).
      try {
        await db.prepare(`DELETE FROM webhook_events WHERE event_key = ?`).bind(eventKey).run();
      } catch (_) {}
      return new Response('Booking not found', { status: 404, headers: corsHeaders(request) });
    }

    const booking = bookings[idx];

    // ===== PURCHASE PAID =====
    if (event === 'purchase.paid' || status === 'completed') {
      let lockResult;
      try {
        // C4: canonical lock. Finalize + potential auto-refund live
        // inside one atomic block.
        lockResult = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const finalizeResult = await finalizePaidBooking(db, booking.id);
          if (finalizeResult.error) return { finalizeResult };
          if (finalizeResult.refuseFinalize) {
            const refundResult = await tryAutoRefundLatePaymentLocked(db, booking.id, env);
            return { finalizeResult, refundResult };
          }
          return { finalizeResult };
        }, 60000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          // Another confirmation path is finalizing. Give it a moment,
          // then re-read and answer from the fresh state.
          await new Promise(res => setTimeout(res, 800));
          const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bb = [];
          try { if (rr?.data) bb = JSON.parse(rr.data); } catch (_) {}
          const cur = bb.find(b => String(b.id) === String(booking.id));
          if (cur && (cur.status === 'Paid - Awaiting Check-in' || String(cur.status).startsWith('Completed'))) {
            lockResult = { finalizeResult: { alreadyFinalized: true, booking: cur, checkinCode: cur.checkinCode } };
          } else {
            throw lockErr;
          }
        } else {
          throw lockErr;
        }
      }

      const finalizeResult = lockResult.finalizeResult;

      // Finalization failure must return 500 so CHIP retries.
      if (finalizeResult.error) {
        console.error(`Finalize error: ${finalizeResult.error}`);
        try {
          await db.prepare(`DELETE FROM webhook_events WHERE event_key = ?`).bind(eventKey).run();
        } catch (_) {}
        return new Response('Finalize failed', { status: 500, headers: corsHeaders(request) });
      } else if (finalizeResult.alreadyFinalized) {
        console.log(`Booking ${booking.id} already finalized by another path. Skipping email.`);
      } else if (finalizeResult.refuseFinalize) {
        const refundResult = lockResult.refundResult || { error: 'refund not attempted' };
        await logAction({
          db,
          action: refundResult.success ? 'late_payment_auto_refunded' : 'late_payment_refund_failed',
          admin: 'system',
          details: `Refused to finalize ${booking.id}: ${finalizeResult.reason}. Refund: ${refundResult.success ? refundResult.refundId : refundResult.error}`,
          ip: getClientIP(request),
          userId: booking.guestId,
          homestayId: booking.homestayId
        });
        console.log(`Late-payment auto-refund for ${booking.id}:`, refundResult);
      } else if (finalizeResult.finalized) {
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
      try {
        await withLock(db, BOOKINGS_LOCK, async (db) => {
          const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bb = [];
          try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
          const ii = bb.findIndex(b => String(b.id) === String(booking.id));
          if (ii === -1) return;
          const cur = bb[ii];
          const currentStatus = String(cur.status || '');
          const isTerminal = currentStatus === 'Paid - Awaiting Check-in'
            || currentStatus.startsWith('Completed')
            || /cancelled|refunded|expired/i.test(currentStatus);
          if (isTerminal) {
            console.log(`Booking ${booking.id} already terminal (${currentStatus}) — ignoring failed event.`);
            return;
          }
          bb[ii] = { ...cur, status: 'Payment Failed', chip_status: 'failed' };
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bb))
            .run();
          console.log(`Booking ${booking.id} marked as FAILED`);
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          console.warn(`Webhook failed-event: lock busy for ${booking.id}. verify-payment will reconcile.`);
        } else {
          throw lockErr;
        }
      }
    }

    // ===== PURCHASE REFUNDED (completion of a refund) =====
    else if (event === 'purchase.refunded' || event === 'payment.refunded' || status === 'refunded') {
      const refundedAmount = payload.data?.refunded_amount
        ? Number(payload.data.refunded_amount) / 100
        : (booking.refund_amount || booking.amount_paid || booking.total || 0);

      let emailTarget = null;
      try {
        await withLock(db, BOOKINGS_LOCK, async (db) => {
          const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bb = [];
          try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
          const ii = bb.findIndex(b => String(b.id) === String(booking.id));
          if (ii === -1) return;
          const cur = bb[ii];
          bb[ii] = {
            ...cur,
            status: 'Refunded',
            chip_status: 'refunded',
            refunded_at: new Date().toISOString(),
            refund_amount: refundedAmount,
            chip_refund_id: payload.data?.refund_id || payload.data?.id || cur.chip_refund_id || 'webhook_refund',
            refund_pending: false
          };
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bb))
            .run();
          emailTarget = bb[ii];
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          console.warn(`Webhook refunded-event: lock busy for ${booking.id}. Reconcile later.`);
          return new Response('OK', { status: 200, headers: corsHeaders(request) });
        }
        throw lockErr;
      }

      if (emailTarget) {
        const result = await sendRefundEmail(emailTarget, env);
        if (result.emailSent) {
          console.log(`Refund email sent to ${booking.guestEmail}`);
        } else {
          console.warn(`Refund email failed: ${result.emailError}`);
        }
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

    // ===== PURCHASE PENDING REFUND (acquirer processing) =====
    else if (event === 'purchase.pending_refund' || status === 'pending_refund') {
      try {
        await withLock(db, BOOKINGS_LOCK, async (db) => {
          const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bb = [];
          try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
          const ii = bb.findIndex(b => String(b.id) === String(booking.id));
          if (ii === -1) return;
          const cur = bb[ii];
          bb[ii] = {
            ...cur,
            status: 'Refund Pending - Awaiting CHIP',
            chip_status: 'pending_refund',
            chip_refund_id: payload.data?.refund_id || payload.data?.id || cur.chip_refund_id || null,
            refund_pending: true,
            refund_pending_at: new Date().toISOString()
          };
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bb))
            .run();
          console.log(`Booking ${booking.id} refund PENDING`);
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          console.warn(`Webhook pending_refund-event: lock busy for ${booking.id}. Reconcile later.`);
        } else {
          throw lockErr;
        }
      }
    }

    return new Response('OK', { status: 200, headers: corsHeaders(request) });

  } catch (e) {
    console.error('Webhook error:', e.message);

    // Roll back the dedup row so CHIP's automatic retry re-processes
    // this event instead of silently no-op'ing on the retry.
    if (db && eventKey) {
      try {
        await db.prepare(`DELETE FROM webhook_events WHERE event_key = ?`).bind(eventKey).run();
      } catch (_) { /* best-effort */ }
    }

    return new Response('Internal server error', { status: 500, headers: corsHeaders(request) });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
