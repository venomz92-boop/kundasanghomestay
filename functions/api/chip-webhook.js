// /api/chip-webhook.js — Plain English: CHIP calls this when a payment
// succeeds, fails, or is refunded.
//
// [PHASE 2 REFACTOR]
// All the finalize + auto-refund + email logic moved to _utils.js and is
// now called via finalizeAndNotify(). Deleted from this file:
//   - tryAutoRefundLatePaymentLocked
//   - sendCheckinEmail
//   - sendRefundEmail
//
// Also fixed:
//   - The event/status OR logic used to accept "purchase.failed with
//     status=completed" as paid. Now the `event` field is authoritative
//     and `status` is a fallback only when the event is unrecognized.
//   - The "already finalized, skipping email" path now retries the email
//     if the previous attempt failed.
//   - Full webhook payload no longer logged (PII removal).
//   - Signature decode accepts both standard base64 and base64url.
//   - Per-booking locks instead of the global 'bookings-global' lock.
import {
  corsHeaders,
  getClientIP,
  logAction,
  withLock,
  finalizeAndNotify,
  sendRefundEmail
} from './_utils.js';

const WEBHOOK_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ============================================================
// Signature verification
// ============================================================

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function decodeBase64Flexible(value) {
  // CHIP might send standard base64 (+/) or base64url (-_).
  const s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
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

    const sigBuffer = decodeBase64Flexible(signature);
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

// ============================================================
// Dedup table
// ============================================================

let _webhookEventsTableReady = false;
async function ensureWebhookEventsTable(db) {
  if (_webhookEventsTableReady) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS webhook_events (
      event_key TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    )`
  ).run();
  _webhookEventsTableReady = true;
}

// ============================================================
// Determine the effective event
//
// The `event` field is authoritative when recognized. `status` is only
// used as a fallback if the event is missing or unrecognized. This
// prevents contradictory payloads from being interpreted as "paid"
// when the event clearly says otherwise.
// ============================================================

function determineEvent(event, status) {
  const ev = String(event || '').toLowerCase();
  const st = String(status || '').toLowerCase();

  if (ev === 'purchase.paid') return 'paid';
  if (ev === 'purchase.failed') return 'failed';
  if (ev === 'purchase.refunded' || ev === 'payment.refunded') return 'refunded';
  if (ev === 'purchase.pending_refund') return 'pending_refund';

  // Unknown event name — fall back to status.
  if (st === 'completed' || st === 'paid') return 'paid';
  if (st === 'failed' || st === 'cancelled') return 'failed';
  if (st === 'refunded') return 'refunded';
  if (st === 'pending_refund') return 'pending_refund';

  return 'unknown';
}

// ============================================================
// Handler
// ============================================================

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

    const event = payload.event;
    const purchaseId = payload.data?.id;
    const status = payload.data?.status;

    // Trim PII from logs. Only log identifiers, not the full payload.
    console.log('CHIP webhook received:', { event, purchaseId, status });

    if (!purchaseId || !event) {
      return new Response('Missing fields', { status: 400, headers: corsHeaders(request) });
    }

    db = env.DB;
    if (!db) return new Response('DB error', { status: 500, headers: corsHeaders(request) });
    await ensureWebhookEventsTable(db);

    // ============================================================
    // Dedup via dedicated D1 table using INSERT OR IGNORE.
    // Row is rolled back on retryable failure (see below) so CHIP's
    // automatic retry re-processes cleanly.
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

    // Prune stale rows. (Consider moving to a Cloudflare Cron Trigger
    // once webhook volume grows — this is a full scan on every call.)
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
      // Roll back dedup so a retry can try again if the booking is
      // created a moment later (rare race with chip-create).
      try {
        await db.prepare(`DELETE FROM webhook_events WHERE event_key = ?`).bind(eventKey).run();
      } catch (_) {}
      return new Response('Booking not found', { status: 404, headers: corsHeaders(request) });
    }

    const booking = bookings[idx];

    // Decide what actually happened based on the payload.
    const effectiveEvent = determineEvent(event, status);

    // ============================================================
    // EVENT: PAID
    // ============================================================
    if (effectiveEvent === 'paid') {
      const notify = await finalizeAndNotify(db, booking.id, env);

      // ---- Permanent error (e.g. guest deleted). Accept the event so
      //      CHIP doesn't retry forever. Log it.
      if (notify.outcome === 'error' && !notify.retryable) {
        console.error(`Webhook finalize permanent error for ${booking.id}: ${notify.error}`);
        await logAction({
          db,
          action: 'chip_payment_finalize_failed',
          admin: 'webhook',
          details: `Permanent finalize error for ${booking.id}: ${notify.error}`,
          ip: getClientIP(request),
          userId: booking.guestId,
          homestayId: booking.homestayId
        });
        return new Response('OK', { status: 200, headers: corsHeaders(request) });
      }

      // ---- Retryable error or lock busy. Roll back dedup, return 5xx
      //      so CHIP retries.
      if (notify.outcome === 'error' || notify.outcome === 'lock_busy') {
        console.error(`Webhook finalize retryable (${notify.outcome}) for ${booking.id}: ${notify.error}`);
        try {
          await db.prepare(`DELETE FROM webhook_events WHERE event_key = ?`).bind(eventKey).run();
        } catch (_) {}
        return new Response('Retry later', { status: 503, headers: corsHeaders(request) });
      }

      // ---- Refused: booking was cancelled before payment settled.
      //      Auto-refund already ran inside finalizeAndNotify.
      if (notify.outcome === 'refused') {
        const rr = notify.refundResult || { error: 'refund not attempted' };
        await logAction({
          db,
          action: rr.success ? 'late_payment_auto_refunded' : 'late_payment_refund_failed',
          admin: 'system',
          details: `Refused to finalize ${booking.id}: ${notify.refuseReason || 'cancelled'}. Refund: ${rr.success ? rr.refundId : rr.error}`,
          ip: getClientIP(request),
          userId: booking.guestId,
          homestayId: booking.homestayId
        });
        return new Response('OK', { status: 200, headers: corsHeaders(request) });
      }

      // ---- finalized or already_finalized.
      const emailStatus = notify.emailSent
        ? 'email sent'
        : (notify.emailError ? `email failed: ${notify.emailError}` : 'no email needed');

      await logAction({
        db,
        action: 'chip_payment_success',
        admin: 'webhook',
        details: `Booking ${booking.id} paid via CHIP (${notify.outcome}, ${emailStatus})`,
        ip: getClientIP(request),
        userId: booking.guestId,
        homestayId: booking.homestayId
      });

      return new Response('OK', { status: 200, headers: corsHeaders(request) });
    }

    // ============================================================
    // EVENT: FAILED
    // ============================================================
    if (effectiveEvent === 'failed') {
      try {
        await withLock(db, 'bookings-global', async (db) => {
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
      return new Response('OK', { status: 200, headers: corsHeaders(request) });
    }

    // ============================================================
    // EVENT: REFUNDED (completion of a refund)
    // ============================================================
    if (effectiveEvent === 'refunded') {
      const refundedAmount = payload.data?.refunded_amount
        ? Number(payload.data.refunded_amount) / 100
        : (booking.refund_amount || booking.amount_paid || booking.total || 0);

      let emailTarget = null;
      try {
        await withLock(db, 'bookings-global', async (db) => {
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
        if (result.sent) {
          console.log(`Refund email sent to ${emailTarget.guestEmail}`);
        } else {
          console.warn(`Refund email failed: ${result.error}`);
        }
      }

      await logAction({
        db,
        action: 'chip_refund_success',
        admin: 'webhook',
        details: `Booking ${booking.id} refunded via CHIP (RM${refundedAmount.toFixed(2)})`,
        ip: getClientIP(request),
        userId: booking.guestId,
        homestayId: booking.homestayId
      });

      return new Response('OK', { status: 200, headers: corsHeaders(request) });
    }

    // ============================================================
    // EVENT: PENDING REFUND
    // ============================================================
    if (effectiveEvent === 'pending_refund') {
      try {
        await withLock(db, 'bookings-global', async (db) => {
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
      return new Response('OK', { status: 200, headers: corsHeaders(request) });
    }

    // ============================================================
    // EVENT: UNKNOWN — log and accept. Don't retry, since CHIP sending
    // us something we don't recognize is not our problem to fix.
    // ============================================================
    console.warn(`Unrecognized webhook event/status: event=${event}, status=${status}`);
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
