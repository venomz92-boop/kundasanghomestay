// /api/reviews.js — Guest star reviews.
//
// A guest may leave ONE review per booking, and only after the stay is
// complete (status starts with "Completed"). Reviews are public on the
// listing; the reviewer's surname is never published.
//
//   GET  /api/reviews?homestayId=<id>  → that homestay's reviews (public)
//   GET  /api/reviews                  → { ratings: { [homestayId]: {average,count} } }
//   POST /api/reviews                  → { action?, bookingId?, reviewId?, rating?, comment? }
//     action omitted or 'create' → add a review for a completed booking
//     action 'update'            → change your own review
//     action 'delete'            → remove your own review
//
//   Only the guest who wrote a review may edit or delete it. This is
//   enforced by comparing review.guestId to the caller's guest session.
//   Hosts use a different session type entirely, so a host can never
//   change or remove a guest's rating — fair to both sides.
import {
  corsHeaders,
  getClientIP,
  enforceHttps,
  verifyAdminAuth,
  getGuestSession,
  jsonResponse,
  parseJSONSafely,
  withLock,
  checkRateLimit,
  recordRateLimit,
  logAction
} from './_utils.js';

const REVIEWS_KEY = 'kd_reviews';
const MAX_COMMENT = 500;
const MAX_REVIEWS_STORED = 5000;
const BOOKINGS_LOCK = 'bookings-global';

// "Frandher Chung" → "Frandher C." Keeps reviews warm without publishing
// a full legal name.
function publicName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Guest';
  if (parts.length === 1) return parts[0].slice(0, 40);
  return parts[0].slice(0, 40) + ' ' + parts[1][0].toUpperCase() + '.';
}

function clampRating(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return n >= 1 && n <= 5 ? n : 0;
}

function shapeReview(r) {
  return {
    id: r.id,
    rating: r.rating,
    comment: String(r.comment || '').slice(0, MAX_COMMENT),
    guestName: publicName(r.guestName),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt || null
  };
}

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  try {
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    const url = new URL(request.url);
    const homestayId = String(url.searchParams.get('homestayId') || '').trim();

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind(REVIEWS_KEY).first();
    let reviews = [];
    try { if (r?.data) reviews = JSON.parse(r.data); } catch (_) {}
    if (!Array.isArray(reviews)) reviews = [];

    // Admin break-glass: list reviews whose booking no longer exists.
    // Exactly the set that no other route can reach. Admin-gated.
    if (String(url.searchParams.get('admin') || '') === 'orphans') {
      if (!(await verifyAdminAuth(request, env))) {
        return jsonResponse({ error: 'Unauthorized' }, 401, request);
      }
      const br = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      let bookings = [];
      try { if (br?.data) bookings = JSON.parse(br.data); } catch (_) {}
      if (!Array.isArray(bookings)) bookings = [];
      const live = new Set(bookings.map(b => String(b.id)));
      const orphans = reviews
        .filter(x => !live.has(String(x.bookingId)))
        .map(x => ({
          id: x.id,
          bookingId: x.bookingId,
          homestayId: x.homestayId,
          rating: x.rating,
          comment: String(x.comment || '').slice(0, MAX_COMMENT),
          guestName: publicName(x.guestName),
          createdAt: x.createdAt,
          updatedAt: x.updatedAt || null
        }));
      return jsonResponse({ orphans, count: orphans.length }, 200, request, { 'Cache-Control': 'no-store' });
    }

        // Admin break-glass: every review, flagged with whether its booking
    // still exists. The admin dashboard can remove any of them.
    if (String(url.searchParams.get('admin') || '') === 'all') {
      if (!(await verifyAdminAuth(request, env))) {
        return jsonResponse({ error: 'Unauthorized' }, 401, request);
      }
      const br = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      let bookings = [];
      try { if (br?.data) bookings = JSON.parse(br.data); } catch (_) {}
      if (!Array.isArray(bookings)) bookings = [];
      const live = new Set(bookings.map(b => String(b.id)));
      const all = reviews
        .slice()
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .map(x => ({
          id: x.id,
          bookingId: x.bookingId,
          homestayId: x.homestayId,
          rating: x.rating,
          comment: String(x.comment || '').slice(0, MAX_COMMENT),
          guestName: publicName(x.guestName),
          createdAt: x.createdAt,
          updatedAt: x.updatedAt || null,
          orphaned: !live.has(String(x.bookingId))
        }));
      return jsonResponse({
        reviews: all,
        count: all.length,
        orphanCount: all.filter(r => r.orphaned).length
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

    if (homestayId) {
      const mine = reviews.filter(x => String(x.homestayId) === homestayId);
      const count = mine.length;
      const average = count
        ? Math.round((mine.reduce((s, x) => s + (Number(x.rating) || 0), 0) / count) * 10) / 10
        : 0;
            // Star breakdown for the ratings panel, counted over ALL reviews
      // (not just the 30 we return).
      const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      for (const x of mine) {
        const n = clampRating(x.rating);
        if (n) distribution[n] += 1;
      }

      const latest = mine
        .slice()
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, 30)
        .map(shapeReview);
      return jsonResponse({ reviews: latest, average, count, distribution }, 200, request, { 'Cache-Control': 'no-store' });
    }

    // No homestayId → aggregates only, so the payload stays small even as
    // reviews accumulate.
    const totals = {};
    for (const x of reviews) {
      const k = String(x.homestayId);
      if (!totals[k]) totals[k] = { sum: 0, count: 0 };
      totals[k].sum += Number(x.rating) || 0;
      totals[k].count += 1;
    }
    const ratings = {};
    for (const k in totals) {
      ratings[k] = {
        count: totals[k].count,
        average: Math.round((totals[k].sum / totals[k].count) * 10) / 10
      };
    }
    return jsonResponse({ ratings }, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('reviews GET error:', e.message);
    return jsonResponse({ error: 'Could not load reviews' }, 500, request);
  }
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  try {
        const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);

    // Parsed once, up here, because a Request body can only be consumed
    // once and the admin branch below needs it before the guest gate.
    // `body` was parsed above, before the admin break-glass branch — a
    // Request body can only be consumed once, so it is not read again.

    // ---------------- ADMIN BREAK-GLASS DELETE ----------------
    // Deliberately above the guest gate: an admin is not a guest session.
    // This is the only remaining route that can remove a review. A review
    // whose booking was deleted is otherwise stranded — the guest UI is
    // driven by the booking record, so with the booking gone there is no
    // Edit or Delete to offer, and hosts are blocked from touching guest
    // ratings by design. Without this the row would sit on the listing
    // permanently. Admin session required; guests and hosts cannot reach it.
    if (String(body?.action || '').toLowerCase() === 'admin-delete') {
      if (!(await verifyAdminAuth(request, env))) {
        return jsonResponse({ error: 'Unauthorized' }, 401, request);
      }
      const targetId = String(body?.reviewId || '').trim();
      if (!targetId) return jsonResponse({ error: 'Missing review' }, 400, request);

      let removed;
      try {
        removed = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const rr = await db.prepare('SELECT data FROM store WHERE key = ?').bind(REVIEWS_KEY).first();
          let reviews = [];
          try { if (rr?.data) reviews = JSON.parse(rr.data); } catch (_) {}
          if (!Array.isArray(reviews)) reviews = [];
          const i = reviews.findIndex(x => String(x.id) === targetId);
          if (i === -1) return null;
          const gone = reviews.splice(i, 1)[0];
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind(REVIEWS_KEY, JSON.stringify(reviews)).run();
          return gone;
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }

      if (!removed) return jsonResponse({ error: 'Review not found' }, 404, request);

      // Logged as an admin action, naming the homestay, so a break-glass
      // removal is always attributable in the audit trail.
      await logAction({
        db,
        action: 'review_deleted_by_admin',
        admin: 'admin',
        details: `Admin break-glass delete: review ${targetId} (booking ${removed.bookingId}, homestay ${removed.homestayId}) — ${removed.rating} star`,
        ip: getClientIP(request),
        userId: removed.guestId,
        homestayId: removed.homestayId
      });

      return jsonResponse({ success: true, message: 'Review permanently removed.' }, 200, request);
    }

    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Please sign in first.' }, 401, request);
    }

    const clientIP = getClientIP(request);
    // Generous enough that editing a review is never blocked, still bounded.
    const ok = await checkRateLimit(db, clientIP, 'review_write', 20, 3600);
    if (!ok) return jsonResponse({ error: 'Too many review changes. Please try again later.' }, 429, request);

    let body;
    try { body = await parseJSONSafely(request); } catch (_) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }

    const action = String(body?.action || 'create').toLowerCase();
    // Delete is refused outright. If a guest could remove a rating and
    // write a fresh one, the one-edit limit below would mean nothing.
    if (action === 'delete') {
      return jsonResponse({
        error: 'A review cannot be deleted once submitted.',
        code: 'REVIEW_NOT_DELETABLE'
      }, 400, request);
    }
    if (!['create', 'update'].includes(action)) {
      return jsonResponse({ error: 'Unsupported action' }, 400, request);
    }

    const bookingId = String(body?.bookingId || '').trim();
    const reviewId = String(body?.reviewId || '').trim();
    const rating = clampRating(body?.rating);
    const comment = String(body?.comment || '').trim().slice(0, MAX_COMMENT);

    if (action === 'create' && !bookingId) return jsonResponse({ error: 'Missing booking' }, 400, request);
    if (action === 'update' && !reviewId) return jsonResponse({ error: 'Missing review' }, 400, request);
    if (!rating) {
      return jsonResponse({ error: 'Please choose a star rating from 1 to 5.' }, 400, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const rr = await db.prepare('SELECT data FROM store WHERE key = ?').bind(REVIEWS_KEY).first();
        let reviews = [];
        try { if (rr?.data) reviews = JSON.parse(rr.data); } catch (_) {}
        if (!Array.isArray(reviews)) reviews = [];

        // ---------------- CREATE ----------------
        if (action === 'create') {
          const br = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          let bookings = [];
          try { if (br?.data) bookings = JSON.parse(br.data); } catch (_) {}
          const b = bookings.find(x => String(x.id) === String(bookingId));
          if (!b) return { error: 'Booking not found', status: 404 };
          if (String(b.guestId) !== String(session.userId)) {
            return { error: 'You can only review your own bookings.', status: 403 };
          }
          // Only a completed stay is reviewable.
          if (!String(b.status || '').startsWith('Completed')) {
            return { error: 'You can review this stay once it is complete.', status: 400 };
          }

          const already = reviews.find(x => String(x.bookingId) === String(bookingId));
          if (already) return { alreadyExists: true, review: already };

          const review = {
            id: 'RV-' + crypto.randomUUID(),
            bookingId: String(bookingId),
            homestayId: String(b.homestayId),
            guestId: String(session.userId),
            guestName: String(b.guestName || ''),
            rating,
            comment,
            createdAt: new Date().toISOString()
          };
          reviews.push(review);
          if (reviews.length > MAX_REVIEWS_STORED) {
            reviews = reviews.slice(reviews.length - MAX_REVIEWS_STORED);
          }
          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind(REVIEWS_KEY, JSON.stringify(reviews)).run();
          return { review, mode: 'created' };
        }

        // ---------------- UPDATE (one edit only) ----------------
        // guestId is the only thing that grants access. A host session can
        // never reach here (getGuestSession rejects it above), so hosts
        // cannot alter or remove a guest's rating.
        const idx = reviews.findIndex(x => String(x.id) === reviewId);
        if (idx === -1) return { error: 'Review not found', status: 404 };
        if (String(reviews[idx].guestId) !== String(session.userId)) {
          return { error: 'You can only change your own review.', status: 403 };
        }

        // One correction, then final. updatedAt is written only by this
        // branch, so an existing value means the edit is already spent.
        // Checked here, inside the lock, so two fast clicks cannot both
        // pass — a UI-only guard would lose that race.
        if (reviews[idx].updatedAt) {
          return {
            error: 'You have already used your one edit — your review is now final.',
            status: 400
          };
        }

        reviews[idx] = {
          ...reviews[idx],
          rating,
          comment,
          updatedAt: new Date().toISOString()
        };
        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind(REVIEWS_KEY, JSON.stringify(reviews)).run();
        return { review: reviews[idx], mode: 'updated' };
      }, 30000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
      }
      throw lockErr;
    }

    if (result.error) return jsonResponse({ error: result.error }, result.status || 400, request);
    await recordRateLimit(db, clientIP, 'review_write');

    if (result.alreadyExists) {
      return jsonResponse({
        success: true,
        alreadyExists: true,
        message: 'You have already reviewed this stay. Use Edit Review to correct it once.'
      }, 200, request);
    }

      await logAction({
      db,
      action: result.mode === 'updated' ? 'review_updated' : 'review_submitted',
      admin: 'guest',
      details: `Guest ${result.mode} review for booking ${result.review.bookingId} (homestay ${result.review.homestayId}) — ${rating} star`,
      ip: clientIP,
      userId: session.userId,
      homestayId: result.review.homestayId
    });

    return jsonResponse({
      success: true,
        message: result.mode === 'updated'
        ? 'Your review has been updated. That was your one edit — it is now final.'
        : 'Thank you! Your review is now live. You can correct it once if needed.',
      review: shapeReview(result.review)
    }, 200, request);
  } catch (e) {
    console.error('reviews POST error:', e.message);
    return jsonResponse({ error: 'Could not save your review' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
