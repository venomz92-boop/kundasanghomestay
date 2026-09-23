// /api/cancellation-request.js
//
// THE GUEST'S CANCELLATION REQUEST.
//
// This endpoint RECORDS a request. It does not cancel anything, and it
// does not move any money. The host still decides, exactly as the policy
// says. Its only job is to capture three things the platform otherwise
// never sees:
//
//   1. WHEN the guest asked  (requestedAt — the refund tier measures from this)
//   2. WHY they asked        (reason)
//   3. WHETHER it's an emergency (so support knows to look)
//
// Actions:
//   preview  — read-only. Tells the guest which tier they're in right now
//              and the exact amounts. Writes nothing.
//   submit   — records the request on the booking.
//   withdraw — the guest changes their mind and takes the request back.
//
// Stored on the booking as:
//   cancellationRequest: {
//     requestedAt, reason, emergency, status, requestedBy,
//     withdrawnAt, declinedAt, declineReason, acceptedAt, history[]
//   }
//   status is 'pending_host' | 'withdrawn' | 'declined' | 'accepted'
//
// THE CLOCK RULE (this is the anti-abuse rule):
//   The tier is fixed by the first request that is STILL WAITING on the
//   host. If the host declines it, or the guest withdraws it, a later
//   request starts a fresh clock. This is what stops a guest from asking
//   early "just in case" to bank Tier A, then cancelling late after the
//   host has already said no.

import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  getGuestSession,
  jsonResponse,
  parseJSONSafely,
  withLock,
  checkRateLimit,
  recordRateLimit,
  getCSRFToken,
  validateCSRFToken
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';

const MIN_REASON_LEN = 10;
const MAX_REASON_LEN = 500;
const SUBMIT_LIMIT_PER_HOUR = 5;

// Only a paid, not-yet-used booking can be cancelled.
const CANCELLABLE_STATUS = 'Paid - Awaiting Check-in';

// ============================================================
// CANCELLATION TIERS — the refund maths
//
//   Tier A: guest asked 14+ days before check-in
//   Tier B: guest asked 48 hours to 13 days before
//   Tier C: guest asked under 48 hours before, or after check-in
//
// Check-in reference time is 2:00 PM MYT on the arrival date.
// MYT is UTC+8 with no daylight saving, so that is 06:00 UTC.
//
// Tier A: guest gets everything they paid, less the RM 1.00 refund fee.
//         Host gets nothing.
// Tier B: guest gets half the room price, rounded DOWN to the sen.
//         Host gets the other half — so the two always add up exactly.
// Tier C: guest gets nothing. Host gets the full room price.
// ============================================================

const CHIP_REFUND_FEE = 1.00;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function computeCancellationTier(booking, requestedAtMs) {
  const base = round2(booking?.base);
  const totalPaid = round2(Number(booking?.amount_paid) || Number(booking?.total) || 0);

  const checkin = String(booking?.checkin || '');
  const refMs = /^\d{4}-\d{2}-\d{2}$/.test(checkin)
    ? Date.parse(checkin + 'T06:00:00Z')
    : NaN;

  const askedMs = Number(requestedAtMs);

  // Can't work out the dates. Don't guess — flag it for a human.
  if (!Number.isFinite(refMs) || !Number.isFinite(askedMs)) {
    return {
      tier: null,
      needsReview: true,
      base,
      totalPaid,
      note: 'Could not determine the check-in time or the request time. Needs manual review.'
    };
  }

  const DAY = 86400000;
  const HOUR = 3600000;
  const leadMs = refMs - askedMs;

  let tier;
  if (leadMs >= 14 * DAY) tier = 'A';
  else if (leadMs >= 48 * HOUR) tier = 'B';
  else tier = 'C';

  const guestAmount =
    tier === 'A' ? round2(Math.max(0, totalPaid - CHIP_REFUND_FEE)) :
    tier === 'B' ? Math.floor(base * 50) / 100 :
    0;

  const hostAmount =
    tier === 'A' ? 0 :
    tier === 'B' ? round2(base - guestAmount) :
    base;

  return {
    tier,
    needsReview: false,
    leadMs,
    leadDays: Math.floor(leadMs / DAY),
    leadHours: Math.floor(leadMs / HOUR),
    base,
    totalPaid,
    guestAmount,
    hostAmount,
    platformKeeps: round2(totalPaid - guestAmount - hostAmount),
    chipRefundFee: CHIP_REFUND_FEE
  };
}

function cleanReason(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON_LEN);
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'Server error' }, 500, request);

  try {
    // ---------- AUTH ----------
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }
    const csrf = getCSRFToken(request);
    const sessionSv = Number(session.sessionVersion ?? 0);
    if (!csrf || !(await validateCSRFToken(csrf, session.userId, env, sessionSv))) {
      return jsonResponse({ error: 'Invalid security token' }, 403, request);
    }

    // ---------- BODY ----------
    let body;
    try {
      body = await parseJSONSafely(request);
    } catch (_) {
      return jsonResponse({ error: 'Invalid request body' }, 400, request);
    }

    const action = String(body.action || '').trim();
    const bookingId = String(body.bookingId || '').trim();

    if (!['preview', 'submit', 'withdraw'].includes(action)) {
      return jsonResponse({ error: 'Invalid action' }, 400, request);
    }
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    const clientIP = getClientIP(request);

    // ---------- RATE LIMIT (writes only) ----------
    if (action !== 'preview') {
      const rateKey = `cancellation_${action}_${session.userId}`;
      const ok = await checkRateLimit(db, clientIP, rateKey, SUBMIT_LIMIT_PER_HOUR, 60 * 60);
      if (!ok) {
        return jsonResponse({
          error: 'Too many requests. Please wait a little while and try again, or email support@kundasanghomestay.my.'
        }, 429, request);
      }
      await recordRateLimit(db, clientIP, rateKey);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ---------- UNLOCKED READ: ownership + state check ----------
    const r0 = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let pre = [];
    try { if (r0?.data) pre = JSON.parse(r0.data); } catch (_) {}
    const preBooking = pre.find(b => String(b.id) === String(bookingId));

    if (!preBooking) return jsonResponse({ error: 'Booking not found' }, 400, request);
    if (String(preBooking.guestId) !== String(session.userId)) {
      return jsonResponse({ error: 'Unauthorized' }, 403, request);
    }

    // ---------- PREVIEW (read-only) ----------
    if (action === 'preview') {
      if (String(preBooking.status) !== CANCELLABLE_STATUS) {
        return jsonResponse({
          success: false,
          error: explainNotCancellable(preBooking)
        }, 200, request);
      }

      const existing = preBooking.cancellationRequest;
      if (existing && existing.status === 'pending_host') {
        return jsonResponse({
          success: true,
          alreadyPending: true,
          requestedAt: existing.requestedAt,
          reason: existing.reason || '',
          preview: computeCancellationTier(preBooking, Date.parse(existing.requestedAt))
        }, 200, request);
      }

      return jsonResponse({
        success: true,
        alreadyPending: false,
        preview: computeCancellationTier(preBooking, Date.now())
      }, 200, request);
    }

    // ---------- WITHDRAW ----------
    if (action === 'withdraw') {
      let out;
      try {
        out = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const rr = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          let bookings = [];
          try { if (rr?.data) bookings = JSON.parse(rr.data); } catch (_) {}
          const i = bookings.findIndex(b => String(b.id) === String(bookingId));
          if (i === -1) return { error: 'Booking not found', status: 404 };

          const b = bookings[i];
          const req = b.cancellationRequest;
          if (!req || req.status !== 'pending_host') {
            return { error: 'There is no cancellation request waiting to be withdrawn.', status: 400 };
          }

          bookings[i] = {
            ...b,
            cancellationRequest: {
              ...req,
              status: 'withdrawn',
              withdrawnAt: new Date().toISOString(),
              history: appendHistory(req, 'withdrawn', 'Withdrawn by guest')
            },
            statusUpdated: new Date().toISOString()
          };

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          return { success: true, booking: bookings[i] };
        }, 60000);
      } catch (lockErr) {
        if (isLockBusy(lockErr)) return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
        throw lockErr;
      }

      if (out.error) return jsonResponse({ error: out.error }, out.status || 400, request);

      await logAction({
        db,
        action: 'cancellation_request_withdrawn',
        admin: 'guest',
        details: `Guest withdrew the cancellation request on ${bookingId}.`,
        ip: clientIP,
        userId: session.userId,
        homestayId: out.booking.homestayId
      });

      return jsonResponse({
        success: true,
        message: 'Your cancellation request has been withdrawn. Your booking is unchanged.',
        bookingStatus: out.booking.status
      }, 200, request);
    }

    // ---------- SUBMIT ----------
    const reason = cleanReason(body.reason);
    const emergency = body.emergency === true;

    if (reason.length < MIN_REASON_LEN) {
      return jsonResponse({
        error: `Please tell your host why you need to cancel — at least ${MIN_REASON_LEN} characters. This is part of the request.`
      }, 400, request);
    }

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const rr = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
        let bookings = [];
        try { if (rr?.data) bookings = JSON.parse(rr.data); } catch (_) {}
        const i = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (i === -1) return { error: 'Booking not found', status: 404 };

        const b = bookings[i];

        // Re-check inside the lock — the booking may have moved on
        // (paid, cancelled, checked in) while the guest was typing.
        if (String(b.status) !== CANCELLABLE_STATUS) {
          return { error: explainNotCancellable(b), status: 409 };
        }

        const current = b.cancellationRequest;

        // A request is already waiting. Don't create a second one —
        // return the existing one so the guest sees the original date.
        if (current && current.status === 'pending_host') {
          return { alreadyPending: true, requestedAt: current.requestedAt, booking: b };
        }

        // THE CLOCK RULE.
        // Preserve the original requestedAt ONLY if a previous request is
        // still pending — which we already handled above. Otherwise this
        // is a fresh clock: either a first request, or a re-request after
        // the host declined one, or one the guest withdrew.
        const nowIso = new Date().toISOString();

        const nextRequest = {
          requestedAt: nowIso,
          reason,
          emergency,
          status: 'pending_host',
          requestedBy: String(session.userId),
          submittedVia: 'mybookings_form',
          history: current ? appendHistory(current, 'superseded', 'Replaced by a new request') : []
        };

        bookings[i] = {
          ...b,
          cancellationRequest: nextRequest,
          statusUpdated: nowIso
        };

        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(bookings))
          .run();

        return { success: true, booking: bookings[i], requestedAt: nowIso };
      }, 60000);
    } catch (lockErr) {
      if (isLockBusy(lockErr)) return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
      throw lockErr;
    }

    if (result.error) return jsonResponse({ error: result.error }, result.status || 400, request);

    if (result.alreadyPending) {
      return jsonResponse({
        success: true,
        alreadyPending: true,
        requestedAt: result.requestedAt,
        message: 'You already have a cancellation request waiting on your host. We have not created a second one.'
      }, 200, request);
    }

    const tier = computeCancellationTier(result.booking, Date.parse(result.requestedAt));

    await logAction({
      db,
      action: 'cancellation_request_submitted',
      admin: 'guest',
      details:
        `Guest ${session.userId} requested cancellation of ${bookingId}. ` +
        `requestedAt=${result.requestedAt}. Tier=${tier.tier || 'MANUAL REVIEW'}. ` +
        `Emergency flag=${emergency ? 'YES' : 'no'}. Reason: ${reason}`,
      ip: clientIP,
      userId: session.userId,
      homestayId: result.booking.homestayId
    });

    return jsonResponse({
      success: true,
      requestedAt: result.requestedAt,
      preview: tier,
      hostReplyDeadlineHours: hoursUntilDeadline(result.booking, result.requestedAt),
      message: 'Your request has been sent. Your host must reply within 48 hours (or 6 hours if your check-in is less than 48 hours away).'
    }, 200, request);

  } catch (e) {
    console.error('cancellation-request error:', e.message);
    return jsonResponse({ error: 'Something went wrong. Please try again, or email support@kundasanghomestay.my.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

// ---------- helpers ----------

function isLockBusy(err) {
  return !!(err && err.message && err.message.includes('in progress'));
}

function appendHistory(req, event, note) {
  const history = Array.isArray(req?.history) ? req.history.slice(-20) : [];
  history.push({ at: new Date().toISOString(), event, note });
  return history;
}

// How long the host has to reply, in hours. 6 if check-in is close, else 48.
function hoursUntilDeadline(booking, requestedAtIso) {
  const ref = Date.parse(String(booking.checkin || '') + 'T06:00:00Z');
  const asked = Date.parse(requestedAtIso);
  if (!Number.isFinite(ref) || !Number.isFinite(asked)) return 48;
  return (ref - asked) < 48 * 3600000 ? 6 : 48;
}

function explainNotCancellable(booking) {
  const s = String(booking?.status || '');
  if (s === 'Pending Payment') {
    return 'You have not paid for this booking yet, so there is nothing to cancel. It will release on its own.';
  }
  if (s.startsWith('Completed')) {
    return 'This stay is already complete, so it cannot be cancelled.';
  }
  if (/cancel/i.test(s)) {
    return 'This booking has already been cancelled.';
  }
  if (/refund/i.test(s)) {
    return 'This booking has already been cancelled and refunded.';
  }
  if (/expired/i.test(s)) {
    return 'This booking has expired.';
  }
  return 'This booking cannot be cancelled at the moment. Please email support@kundasanghomestay.my.';
}
