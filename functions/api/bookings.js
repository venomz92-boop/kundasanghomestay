// /api/bookings.js — Plain English: this file handles all booking reads and
// writes. In THIS revision:
//   (1) approveHomestay and rejectHomestay permanently delete verification
//       images (IC, bank QR, PBT license) from Cloudinary on success.
//   (2) On reject, all property + room photos are also destroyed, and the
//       orphaned bank-QR entry in kd_homestays is removed.
//   (3) deleteOwner now ALSO removes the account from kd_owners.
//   (4) removeApprovedHomestay destroys Cloudinary images and cleans the
//       orphaned kd_homestays row.
//   (5) updateHomestays clears chip_bank_account_id on bank-detail change.
//   (6) updateHomestays MERGES instead of overwriting.
//   (7) New admin action `retryRefund`. It now reads the stored
//       cancel_type on the booking and:
//         - guest_request → refund base only; write the retained fee
//                           to the kd_fee_earnings ledger.
//         - host_own      → refund full amount; no ledger entry.
//         - missing       → treated as host_own (safe default).
//       Booking status and fee ledger are written in a single db.batch.
//   (8) approveHomestay sends an approval notification email to the host.
//   (9) retryRefund now refuses to fire a second refund when a previous
//       attempt left an unclear state (refund_attempted_at set but
//       chip_refund_id missing). This closes a double-refund risk that
//       occurs if CHIP's refund response is lost or the D1 batch write
//       fails after CHIP already accepted the refund. The guard mirrors
//       the identical one already present in owner-update-booking.js.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  validateCSRFToken,
  getCSRFToken,
  getGuestSession,
  verifyAdminAuth,
  jsonResponse,
  parseJSONSafely,
  withLock,
  checkRateLimit,
  recordRateLimit,
  invalidateOwnerSessionsForHomestay,
  sha256
} from './_utils.js';

const MAX_NIGHTS = 60;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_APPROVED_PAGE_SIZE = 100;
const DEFAULT_PENDING_PAGE_SIZE = 100;
const GATEWAY_FEE = 1.00;
const PENDING_EXPIRY_MS = 15 * 60 * 1000;

const BOOKINGS_LOCK = 'bookings-global';

// ============================================================
// Field whitelists
// ============================================================

const PUBLIC_HOMESTAY_FIELDS = [
  'id', 'name', 'location', 'description',
  'ownerName', 'whatsapp',
  'ownerPrice', 'guests', 'bedrooms',
  'image', 'images', 'rooms',
  'blockedDates', 'approved', 'verified',
  'rating', 'reviews', 'createdAt', 'updatedAt'
];

const ADMIN_STATUS_FIELD_WHITELIST = ['status', 'statusUpdated'];

function pickPublicFields(h) {
  if (!h || typeof h !== 'object') return h;
  const out = {};
  for (const k of PUBLIC_HOMESTAY_FIELDS) {
    if (h[k] !== undefined) out[k] = h[k];
  }
  return out;
}

function stripPasswordFields(h) {
  if (!h || typeof h !== 'object') return h;
  const {
    ownerPasswordHash,
    ownerSalt,
    ownerPasswordAlgorithm,
    ownerPasswordVersion,
    ...safe
  } = h;
  return safe;
}

// ============================================================
// Cloudinary destroy helpers
// ============================================================

async function destroyCloudinaryImage(publicId, env) {
  if (!publicId || typeof publicId !== 'string') {
    return { skipped: true };
  }
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    return { error: 'Cloudinary credentials missing' };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `public_id=${publicId}&timestamp=${timestamp}`;
  let signature;
  try {
    signature = await sha256(toSign + apiSecret);
  } catch (e) {
    return { error: 'Signature compute failed: ' + e.message };
  }

  const body = new URLSearchParams({
    public_id: publicId,
    api_key: apiKey,
    timestamp: String(timestamp),
    signature,
    signature_algorithm: 'sha256'
  });

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      }
    );
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      return { error: `Cloudinary HTTP ${res.status}` };
    }
    const ok = data && (data.result === 'ok' || data.result === 'not found');
    return { success: ok, result: data?.result || 'unknown' };
  } catch (e) {
    return { error: 'Network error: ' + e.message };
  }
}

function extractPublicIdFromCloudinaryUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const m = url.match(/\/upload\/v\d+\/(.+?)(?:\?|$)/);
    if (!m || !m[1]) return null;
    return m[1].replace(/\.\w+$/, '');
  } catch (_) {
    return null;
  }
}

function collectVerificationPublicIds(h) {
  const ids = [];
  if (!h) return ids;

  if (h.icPublicId) ids.push(h.icPublicId);
  else if (h.icImage) {
    const pid = extractPublicIdFromCloudinaryUrl(h.icImage);
    if (pid) ids.push(pid);
  }

  if (h.bankQRPublicId) ids.push(h.bankQRPublicId);
  else if (h.bankQRImage) {
    const pid = extractPublicIdFromCloudinaryUrl(h.bankQRImage);
    if (pid) ids.push(pid);
  }

  if (h.pbtLicensePublicId) ids.push(h.pbtLicensePublicId);
  else if (h.pbtLicense) {
    const pid = extractPublicIdFromCloudinaryUrl(h.pbtLicense);
    if (pid) ids.push(pid);
  }

  return ids.filter(Boolean);
}

function collectAllImagePublicIds(h) {
  const ids = collectVerificationPublicIds(h);
  if (!h) return ids;

  if (Array.isArray(h.imagePublicIds)) {
    h.imagePublicIds.forEach(p => { if (p) ids.push(p); });
  } else if (Array.isArray(h.images)) {
    h.images.forEach(url => {
      const pid = extractPublicIdFromCloudinaryUrl(url);
      if (pid) ids.push(pid);
    });
  }
  if (h.image && !Array.isArray(h.imagePublicIds)) {
    const pid = extractPublicIdFromCloudinaryUrl(h.image);
    if (pid) ids.push(pid);
  }

  if (Array.isArray(h.rooms)) {
    h.rooms.forEach(room => {
      if (Array.isArray(room.imagePublicIds)) {
        room.imagePublicIds.forEach(p => { if (p) ids.push(p); });
      } else if (Array.isArray(room.images)) {
        room.images.forEach(url => {
          const pid = extractPublicIdFromCloudinaryUrl(url);
          if (pid) ids.push(pid);
        });
      }
    });
  }

  return [...new Set(ids.filter(Boolean))];
}

// ============================================================
// Helpers
// ============================================================

function getDatesInRange(checkin, checkout) {
  if (!checkin || !checkout) return [];
  const dates = [];
  const start = new Date(checkin + 'T00:00:00');
  const end = new Date(checkout + 'T00:00:00');
  if (isNaN(start) || isNaN(end) || start >= end) return [];
  const cur = new Date(start);
  while (cur < end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function isDeadBookingStatus(status) {
  return /cancelled|failed|expired|refunded/i.test(String(status || ''));
}

async function verifyAdmin(request, env) {
  const ok = await verifyAdminAuth(request, env);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: corsHeaders(request)
    });
  }
  return null;
}

async function requireGuest(request, env, body) {
  const session = await getGuestSession(request, env);
  if (!session || session.type !== 'guest') {
    return { error: jsonResponse({ error: 'Authentication required' }, 401, request) };
  }
  const guestId = body?.booking?.guestId || body?.guestId;
  if (guestId && String(guestId) !== String(session.userId)) {
    return { error: jsonResponse({ error: 'Guest identity mismatch' }, 403, request) };
  }
  const csrf = getCSRFToken(request);
  if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) {
    return { error: jsonResponse({ error: 'Invalid security token' }, 403, request) };
  }
  return { session };
}

// ============================================================
// Rejection notification email
// ============================================================
async function sendRejectionEmail(homestay, reason, env) {
  if (!homestay.ownerEmail) {
    return { sent: false, error: 'No email address on file' };
  }
  const safe = (s) => String(s || '').replace(/[<>]/g, '');
  const reasonHtml = reason
    ? `<p><strong>Reason provided:</strong></p>
       <p style="background:#fef3c7;padding:12px;border-radius:8px;border:1px solid #fde68a;">${safe(reason)}</p>`
    : `<p>If you have any questions, please contact support.</p>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#0F382E;">Hello ${safe(homestay.ownerName || 'Host')},</h2>
      <p>Thank you for submitting your homestay "<strong>${safe(homestay.name)}</strong>" to Kundasang Homestay.</p>
      <p>After reviewing your listing, we are unable to approve it at this time.</p>
      ${reasonHtml}
      <p>You are welcome to submit a new listing with the required corrections. If you believe this was a mistake, please contact <a href="mailto:support@kundasanghomestay.my">support@kundasanghomestay.my</a>.</p>
      <p>— Kundasang Homestay Team</p>
    </div>
  `;

  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: homestay.ownerEmail,
          subject: 'Update on Your Homestay Listing — Kundasang Homestay',
          html
        })
      });
      return { sent: r.ok, error: r.ok ? null : 'Resend API error' };
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: homestay.ownerEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Update on Your Homestay Listing — Kundasang Homestay',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return { sent: r.ok, error: r.ok ? null : 'SendGrid API error' };
    }
    return { sent: false, error: 'No email provider configured' };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

// ============================================================
// Approval notification email
// ============================================================
async function sendApprovalEmail(homestay, env) {
  if (!homestay.ownerEmail) {
    return { sent: false, error: 'No email address on file' };
  }
  const safe = (s) => String(s || '').replace(/[<>]/g, '');
  const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
  const dashboardUrl = `${domain}/owner.html`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#0F382E;">Hello ${safe(homestay.ownerName || 'Host')},</h2>
      <p>Great news — your homestay listing <strong>"${safe(homestay.name)}"</strong> has been reviewed and approved.</p>
      <p>It is now <strong>live on Kundasang Homestay</strong> and guests can start booking it.</p>

      <div style="background:#f0fdf4;padding:16px;border-radius:8px;border:1px solid #bbf7d0;margin:20px 0;">
        <p style="margin:0 0 8px 0;"><strong>What happens next:</strong></p>
        <ul style="margin:0;padding-left:20px;line-height:1.7;">
          <li>Guests can now see and book your property.</li>
          <li>When a guest checks in, you confirm their arrival with the 6-digit code they received by email.</li>
          <li>Your payout is sent automatically to your bank account via CHIP Send after each check-in.</li>
          <li>You can manage availability, pricing, and view bookings from your Host Dashboard.</li>
        </ul>
      </div>

      <p style="text-align:center;margin:24px 0;">
        <a href="${dashboardUrl}" style="display:inline-block;padding:14px 28px;background:#0F382E;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:bold;">Open Your Host Dashboard &rarr;</a>
      </p>

      <p>If you have any questions, just reply to this email or contact us at <a href="mailto:support@kundasanghomestay.my">support@kundasanghomestay.my</a>.</p>
      <p>Thank you for being part of Kundasang Homestay.</p>
      <p>— Kundasang Homestay Team</p>
    </div>
  `;

  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: homestay.ownerEmail,
          subject: 'Your Homestay Listing is Approved — Kundasang Homestay',
          html
        })
      });
      return { sent: r.ok, error: r.ok ? null : 'Resend API error' };
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: homestay.ownerEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Your Homestay Listing is Approved — Kundasang Homestay',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return { sent: r.ok, error: r.ok ? null : 'SendGrid API error' };
    }
    return { sent: false, error: 'No email provider configured' };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

// ============================================================
// GET
// ============================================================
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const guestSession = await getGuestSession(request, env);
    const isAdmin = await verifyAdminAuth(request, env);

    const keys = ['kd_bookings', 'kd_approved', 'kd_pending', 'kd_guests',
                  'kd_demo_overrides', 'kd_demo_blocked', 'kd_deleted_demo'];
    const stmts = keys.map(key => db.prepare('SELECT data FROM store WHERE key = ?').bind(key));
    const results = await db.batch(stmts);

    const dataMap = {};
    keys.forEach((key, index) => {
      const row = results[index]?.results?.[0];
      try { dataMap[key] = row?.data ? JSON.parse(row.data) : []; } catch (_) { dataMap[key] = []; }
    });

    const bookings = dataMap['kd_bookings'];
    const approved = dataMap['kd_approved'];
    const pending = dataMap['kd_pending'];
    const guests = dataMap['kd_guests'];
    const demoOverrides = dataMap['kd_demo_overrides'];
    const demoBlocked = dataMap['kd_demo_blocked'];
    const deletedDemo = dataMap['kd_deleted_demo'];

    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const limit = parseInt(url.searchParams.get('limit')) || DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * limit;

    // ============ ADMIN BRANCH ============
    if (isAdmin) {
      const paginated = bookings.slice(offset, offset + limit);

      const safeGuests = guests.map(g => {
        const {
          password, salt, passwordAlgorithm, passwordVersion,
          sessionVersion, verifiedAt, ...safe
        } = g;
        return safe;
      });

      const guestsPage = parseInt(url.searchParams.get('guestsPage')) || 1;
      const guestsLimit = parseInt(url.searchParams.get('guestsLimit')) || 200;
      const guestsOffset = (guestsPage - 1) * guestsLimit;
      const paginatedGuests = safeGuests.slice(guestsOffset, guestsOffset + guestsLimit);

      const ownerMap = new Map();
      const addOwner = (h) => {
        if (!h) return;
        const email = String(h.ownerEmail || '').toLowerCase().trim();
        const wa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
        const key = email || wa || String(h.id || '');
        if (!key) return;

        if (ownerMap.has(key)) {
          const existing = ownerMap.get(key);
          if (h.approved === true || h.verified === true) existing.verified = true;
          if (h.name) existing.homestayNames.push(h.name);
          return;
        }

        ownerMap.set(key, {
          id: h.id,
          ownerName: h.ownerName || '',
          ownerEmail: h.ownerEmail || '',
          whatsapp: h.whatsapp || '',
          verified: h.approved === true || h.verified === true,
          createdAt: h.createdAt || null,
          homestayNames: h.name ? [h.name] : []
        });
      };
      approved.forEach(addOwner);
      pending.forEach(addOwner);
      const owners = [...ownerMap.values()];

      const safeApprovedAdmin = approved.map(stripPasswordFields);
      const safePendingAdmin = pending.map(stripPasswordFields);

      const approvedPage = parseInt(url.searchParams.get('approvedPage')) || 1;
      const approvedLimit = parseInt(url.searchParams.get('approvedLimit')) || DEFAULT_APPROVED_PAGE_SIZE;
      const approvedOffset = (approvedPage - 1) * approvedLimit;
      const paginatedApproved = safeApprovedAdmin.slice(approvedOffset, approvedOffset + approvedLimit);

      const pendingPage = parseInt(url.searchParams.get('pendingPage')) || 1;
      const pendingLimit = parseInt(url.searchParams.get('pendingLimit')) || DEFAULT_PENDING_PAGE_SIZE;
      const pendingOffset = (pendingPage - 1) * pendingLimit;
      const paginatedPending = safePendingAdmin.slice(pendingOffset, pendingOffset + pendingLimit);

      return jsonResponse({
        bookings: paginated,
        total: bookings.length,
        page,
        limit,
        totalPages: Math.ceil(bookings.length / limit),
        approved: paginatedApproved,
        approvedTotal: safeApprovedAdmin.length,
        approvedPage,
        approvedLimit,
        demoOverrides,
        demoBlocked,
        deletedDemo,
        pending: paginatedPending,
        pendingTotal: safePendingAdmin.length,
        pendingPage,
        pendingLimit,
        guests: paginatedGuests,
        guestsTotal: safeGuests.length,
        guestsPage,
        guestsLimit,
        owners
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

    // ============ GUEST BRANCH ============
    if (guestSession && guestSession.type === 'guest') {
      const mine = bookings.filter(b => String(b.guestId) === String(guestSession.userId));
      const paginated = mine.slice(offset, offset + limit);
      return jsonResponse({
        bookings: paginated,
        total: mine.length,
        page,
        limit,
        totalPages: Math.ceil(mine.length / limit)
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

    // ============ PUBLIC BRANCH ============
    const safeApproved = approved
      .filter(h => h && h.approved === true)
      .map(pickPublicFields);

    const availability = {};
    for (const h of safeApproved) {
      const homestayId = String(h.id);
      availability[homestayId] = bookings
        .filter(b => String(b.homestayId) === homestayId && !isDeadBookingStatus(b.status))
        .flatMap(b => getDatesInRange(b.checkin, b.checkout));
    }

    return jsonResponse({ approved: safeApproved, availability }, 200, request, {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
    });

  } catch (e) {
    console.error('Bookings GET error:', e.message, e.stack);
    return jsonResponse({ error: 'Failed to load bookings' }, 500, request);
  }
}

// ============================================================
// POST
// ============================================================
export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  let body;
  try {
    body = await parseJSONSafely(request);
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON or payload too large' }, 400, request);
  }
  const action = body.action;
  const clientIP = getClientIP(request);

  // ============ PUBLIC: CREATE BOOKING ============
  if (action === "createPublicBooking" && body.booking) {
    const auth = await requireGuest(request, env, body);
    if (auth.error) return auth.error;
    const incoming = body.booking;
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server configuration error' }, 500, request);

    const guestId = String(auth.session.userId);
    const rateKey = `createBooking_${guestId}`;
    const rateOk = await checkRateLimit(db, clientIP, rateKey, 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many booking attempts. Please wait 15 minutes.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, rateKey);

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const homestayId = String(incoming.homestayId || '');
    const checkin = String(incoming.checkin || '');
    const checkout = String(incoming.checkout || '');
    const roomId = incoming.roomId ? String(incoming.roomId) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) {
      return jsonResponse({ error: 'Invalid date format' }, 400, request);
    }
    const d1 = new Date(checkin + 'T00:00:00');
    const d2 = new Date(checkout + 'T00:00:00');
    if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
      return jsonResponse({ error: 'Invalid dates' }, 400, request);
    }
    const nights = Math.round((d2 - d1) / 86400000);
    if (nights < 1) return jsonResponse({ error: 'Minimum 1 night' }, 400, request);
    if (nights > MAX_NIGHTS) return jsonResponse({ error: `Maximum ${MAX_NIGHTS} nights` }, 400, request);
    const today = new Date(); today.setHours(0,0,0,0);
    if (d1 < today) return jsonResponse({ error: 'Cannot book past dates' }, 400, request);

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const approvedRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
        let approved = [];
        try { if (approvedRes?.data) approved = JSON.parse(approvedRes.data); } catch(_) {}
        const homestay = approved.find(h => String(h.id) === homestayId && h.approved === true);
        if (!homestay) return { error: 'Homestay not found or not approved', status: 404 };

        let selectedRoom = null;
        const rooms = homestay.rooms || [];
        if (roomId) {
          selectedRoom = rooms.find(r => String(r.id) === roomId);
          if (!selectedRoom) return { error: 'Selected room not found', status: 400 };
        }
        const ownerPrice = selectedRoom ? parseFloat(selectedRoom.price) : homestay.ownerPrice;
        if (!Number.isFinite(ownerPrice) || ownerPrice <= 0) {
          return { error: 'Invalid price configuration', status: 500 };
        }

        const bookingsRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let allBookings = [];
        try { if (bookingsRes?.data) allBookings = JSON.parse(bookingsRes.data); } catch(_) {}

        const guestsRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
        let guests = [];
        try { if (guestsRes?.data) guests = JSON.parse(guestsRes.data); } catch(_) {}

        const guest = guests.find(g => String(g.id) === String(auth.session.userId));
        if (!guest) return { error: 'Guest not found', status: 404 };

        const existingOwn = allBookings.find(b =>
          String(b.guestId) === String(guest.id) &&
          String(b.homestayId) === String(homestay.id) &&
          b.checkin === checkin &&
          b.checkout === checkout &&
          (b.status === 'Pending Payment' || b.status === 'Payment Failed')
        );
        if (existingOwn) {
          if (existingOwn.status === 'Payment Failed') {
            existingOwn.status = 'Pending Payment';
            existingOwn.date = new Date().toISOString();
            existingOwn.statusUpdated = new Date().toISOString();
            existingOwn.reopenedAt = new Date().toISOString();
            existingOwn.reopenCount = (existingOwn.reopenCount || 0) + 1;
            delete existingOwn.lastPayoutError;
            await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_bookings', JSON.stringify(allBookings))
              .run();
          }
          return { alreadyExists: true, booking: existingOwn, reopened: true };
        }

        const homestayBlocked = new Set((homestay.blockedDates || []).map(String));
        const requestedDates = getDatesInRange(checkin, checkout);
        for (const ds of requestedDates) {
          if (homestayBlocked.has(ds)) {
            return { error: `Selected dates are unavailable (${ds}) due to homestay block`, status: 400 };
          }
        }

        if (selectedRoom) {
          const roomBlocked = new Set((selectedRoom.blockedDates || []).map(String));
          for (const ds of requestedDates) {
            if (roomBlocked.has(ds)) {
              return { error: `Room "${selectedRoom.name}" is blocked on ${ds}`, status: 400 };
            }
          }
        }

        const now = Date.now();
        let modified = false;
        allBookings = allBookings.map(b => {
          const s = String(b.status || '');
          const isPending = s === 'Pending Payment';
          const isFailed = s === 'Payment Failed';
          if (!isPending && !isFailed) return b;
          const stamp = b.date ? Date.parse(b.date) : 0;
          if (!stamp) return b;
          const isStale = (now - stamp) > PENDING_EXPIRY_MS;
          if (!isStale) return b;
          const roomMatch = selectedRoom
            ? String(b.roomId) === String(selectedRoom.id)
            : String(b.homestayId) === String(homestay.id);
          if (!roomMatch) return b;
          const overlaps = checkin < String(b.checkout || '') && checkout > String(b.checkin || '');
          if (!overlaps) return b;
          modified = true;
          return { ...b, status: 'Expired - Abandoned', statusUpdated: new Date().toISOString() };
        });

        const overlaps = allBookings.some(b => {
          const isOwnPending = String(b.guestId) === String(guest.id) &&
            (b.status === 'Pending Payment' || b.status === 'Payment Failed');
          const roomMatch = selectedRoom
            ? String(b.roomId) === String(selectedRoom.id)
            : String(b.homestayId) === String(homestay.id);
          return roomMatch &&
                 !isDeadBookingStatus(b.status) &&
                 !isOwnPending &&
                 checkin < String(b.checkout||'') &&
                 checkout > String(b.checkin||'');
        });
        if (overlaps) {
          return { error: 'Selected dates are already booked for this room', status: 400 };
        }

        const base = Math.round(ownerPrice * nights * 100) / 100;
        const fee = Math.round(base * 0.11 * 100) / 100;
        const gatewayFee = GATEWAY_FEE;
        const total = Math.round((base + fee + gatewayFee) * 100) / 100;

        let bookingId = String(incoming.id || '');
        if (!/^KDH-[A-Za-z0-9_-]{4,40}$/.test(bookingId) || allBookings.some(b=>String(b.id)===bookingId)) {
          bookingId = `KDH-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
        }

        const booking = {
          id: bookingId,
          homestay: homestay.name,
          homestayId: homestay.id,
          ownerWhatsapp: homestay.whatsapp || '',
          guestId: guest.id,
          guestName: guest.name,
          guestEmail: guest.email,
          guestPhone: guest.phone || '',
          checkin: checkin,
          checkout: checkout,
          nights: nights,
          base: base,
          fee: fee,
          gatewayFee: gatewayFee,
          total: total,
          status: 'Pending Payment',
          date: new Date().toISOString(),
          roomId: selectedRoom ? selectedRoom.id : null,
          roomName: selectedRoom ? selectedRoom.name : null,
          roomImages: selectedRoom ? (selectedRoom.images || []) : []
        };

        allBookings.push(booking);

        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(allBookings))
          .run();

        return { booking, expiredCount: modified ? 1 : 0 };
      }, 30000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        return jsonResponse({ error: 'Another booking is being processed. Please try again in a moment.' }, 429, request);
      }
      throw lockErr;
    }

    if (result.error) {
      return jsonResponse({ error: result.error }, result.status || 400, request);
    }

    if (result.alreadyExists) {
      return jsonResponse({
        success: true,
        booking: result.booking,
        alreadyExists: true,
        message: result.reopened
          ? 'Your previous payment attempt failed. We reopened the same booking so you can retry safely.'
          : 'You already have a pending booking for these dates. Please complete the payment.'
      }, 200, request);
    }

    const booking = result.booking;

    await logAction({
      db,
      action: 'booking_created',
      admin: 'guest',
      details: `Booking ${booking.id} created; payment pending${result.expiredCount ? ' (expired stale overlap)' : ''}`,
      ip: clientIP,
      userId: booking.guestId,
      homestayId: booking.homestayId
    });

    return jsonResponse({ success: true, booking: booking }, 200, request);
  }

  // ============ PUBLIC: MARK PAYMENT FAILED ONLY ============
  if (action === "publicUpdateStatus" && body.id) {
    const auth = await requireGuest(request, env, body);
    if (auth.error) return auth.error;

    if (body.status !== 'Payment Failed') {
      return jsonResponse({
        error: 'Guests cannot cancel bookings directly. Please contact the host if you need to cancel.'
      }, 403, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bookings = [];
          try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
          const idx = bookings.findIndex(b => String(b.id) === String(body.id));
          if (idx < 0) return { error: 'Invalid request.', status: 400 };
          const b = bookings[idx];
          if (String(b.guestId) !== String(auth.session.userId)) {
            return { error: 'Unauthorized', status: 403 };
          }

          const currentStatus = String(b.status || '');
          const isTerminal = currentStatus === 'Paid - Awaiting Check-in'
            || currentStatus.startsWith('Completed')
            || /cancelled|refunded|expired/i.test(currentStatus);

          if (isTerminal) {
            return { noop: true, booking: b };
          }

          bookings[idx] = {
            ...b,
            status: 'Payment Failed',
            failed_at: new Date().toISOString(),
            statusUpdated: new Date().toISOString()
          };

          await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
            .bind('kd_bookings', JSON.stringify(bookings)).run();

          return { updated: true, booking: bookings[idx] };
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) {
        return jsonResponse({ error: result.error }, result.status || 400, request);
      }
      if (result.noop) {
        return jsonResponse({ success: true, booking: result.booking, message: 'Booking already finalised.' }, 200, request);
      }

      await logAction({
        db,
        action: 'public_status_updated',
        admin: 'guest',
        details: `Booking ${result.booking.id} marked as Payment Failed`,
        ip: clientIP,
        userId: result.booking.guestId,
        homestayId: result.booking.homestayId
      });

      return jsonResponse({ success: true, booking: result.booking }, 200, request);
    } catch (e) {
      console.error('Guest status update error:', e.message);
      return jsonResponse({ error: 'Could not update booking' }, 500, request);
    }
  }

  // ============ ADMIN ACTIONS ============
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: 'DB not configured' }), {
      status: 500, headers: corsHeaders(request)
    });
  }

  const adminIP = getClientIP(request);
  const rateOk = await checkRateLimit(db, adminIP, 'admin_action', 100, 60);
  if (!rateOk) {
    return jsonResponse({ error: 'Too many admin actions. Please slow down.' }, 429, request);
  }
  await recordRateLimit(db, adminIP, 'admin_action');

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ---- Admin: clearAll ----
    if (action === "clearAll") {
      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify([]))
            .run();
          return { success: true };
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }
      await logAction({
        db,
        action: 'bookings_cleared',
        admin: 'admin',
        details: 'All bookings cleared via clearAll action',
        ip: clientIP
      });
      return jsonResponse({ success: true, bookings: [] }, 200, request);
    }

    // ---- Admin: updateStatus ----
    if (action === "updateStatus" && body.id) {
      const newStatus = String(body.status || '');
      if (!newStatus) {
        return jsonResponse({ error: 'Missing status' }, 400, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          let bookings = [];
          if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
          const idx = bookings.findIndex(b => String(b.id) === String(body.id));
          if (idx === -1) return { error: 'Booking not found', status: 404 };

          const patch = {};
          if (body.booking && typeof body.booking === 'object') {
            for (const key of ADMIN_STATUS_FIELD_WHITELIST) {
              if (body.booking[key] !== undefined) patch[key] = body.booking[key];
            }
          }
          patch.status = newStatus;
          patch.statusUpdated = new Date().toISOString();

          bookings[idx] = { ...bookings[idx], ...patch };

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          return { success: true, booking: bookings[idx] };
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another booking operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) {
        return jsonResponse({ error: result.error }, result.status || 400, request);
      }

      await logAction({
        db,
        action: 'booking_status_updated',
        admin: 'admin',
        details: `Booking ${body.id} status changed to ${newStatus}`,
        ip: clientIP,
        userId: result.booking.guestEmail,
        homestayId: result.booking.homestayId
      });

      return jsonResponse({ success: true, booking: result.booking }, 200, request);
    }

    // ---- Admin: updateDates ----
    if (action === "updateDates" && body.id) {
      const newCheckin = String(body.checkin || '');
      const newCheckout = String(body.checkout || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newCheckin) || !/^\d{4}-\d{2}-\d{2}$/.test(newCheckout)) {
        return jsonResponse({ error: 'Invalid date format' }, 400, request);
      }
      const d1 = new Date(newCheckin + 'T00:00:00');
      const d2 = new Date(newCheckout + 'T00:00:00');
      if (isNaN(d1) || isNaN(d2) || d1 >= d2) {
        return jsonResponse({ error: 'Invalid dates' }, 400, request);
      }
      const newNights = Math.round((d2 - d1) / 86400000);
      if (newNights < 1) return jsonResponse({ error: 'Minimum 1 night' }, 400, request);
      if (newNights > MAX_NIGHTS) {
        return jsonResponse({ error: `Maximum ${MAX_NIGHTS} nights` }, 400, request);
      }

      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          let bookings = [];
          if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
          const idx = bookings.findIndex(b => String(b.id) === String(body.id));
          if (idx === -1) return { error: 'Booking not found', status: 404 };

          const booking = bookings[idx];

          const approvedRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
          let approved = [];
          try { if (approvedRes?.data) approved = JSON.parse(approvedRes.data); } catch(_) {}
          const homestay = approved.find(h => String(h.id) === String(booking.homestayId));
          if (!homestay) return { error: 'Homestay not found', status: 404 };

          let unitPrice = Number(homestay.ownerPrice);
          if (booking.roomId && Array.isArray(homestay.rooms)) {
            const room = homestay.rooms.find(rm => String(rm.id) === String(booking.roomId));
            if (room && Number.isFinite(Number(room.price))) {
              unitPrice = Number(room.price);
            }
          }
          if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
            return { error: 'Invalid price configuration on homestay', status: 500 };
          }

          const base = Math.round(unitPrice * newNights * 100) / 100;
          const fee = Math.round(base * 0.11 * 100) / 100;
          const gatewayFee = GATEWAY_FEE;
          const total = Math.round((base + fee + gatewayFee) * 100) / 100;
          const youReceive = Math.round((base) * 100) / 100;

          bookings[idx] = {
            ...booking,
            checkin: newCheckin,
            checkout: newCheckout,
            nights: newNights,
            base,
            fee,
            gatewayFee,
            total,
            youReceive,
            statusUpdated: new Date().toISOString()
          };

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          return { success: true, booking: bookings[idx] };
        }, 30000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another booking operation is in progress. Please try again in a moment.' }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) {
        return jsonResponse({ error: result.error }, result.status || 400, request);
      }

      await logAction({
        db,
        action: 'booking_dates_changed',
        admin: 'admin',
        details: `Booking ${body.id} dates changed to ${newCheckin}→${newCheckout} (server-recomputed amount RM${result.booking.total})`,
        ip: clientIP,
        userId: result.booking.guestEmail,
        homestayId: result.booking.homestayId
      });

      return jsonResponse({ success: true, booking: result.booking }, 200, request);
    }

    // ---- Admin: retryRefund ----
    // [THIS REVISION]
    // Reads the stored cancel_type on the booking and applies the correct
    // refund amount and ledger write for each case:
    //   - guest_request → refund base; write retained fee to kd_fee_earnings
    //   - host_own (default for missing cancel_type) → refund full amount
    // Booking status + fee ledger are written in a single db.batch.
    //
    // [NEW GUARD in this revision]
    // Refuses to fire a second refund if a prior attempt recorded a marker
    // (refund_attempted_at) but never captured a refund ID. This closes a
    // double-refund risk when CHIP's response is lost or the D1 write
    // fails after CHIP already accepted the refund. Mirrors the identical
    // guard in owner-update-booking.js.
    if (action === "retryRefund" && body.id) {
      const bookingId = String(body.id);
      let result;
      try {
        result = await withLock(db, BOOKINGS_LOCK, async (db) => {
          const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bookings = [];
          try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
          const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
          if (idx === -1) return { error: 'Booking not found', status: 404 };
          const booking = bookings[idx];

          if (!booking.chip_purchase_id) {
            return { error: 'This booking has no CHIP purchase on file. Cannot refund.', status: 400 };
          }
          if (booking.chip_refund_id) {
            return { error: 'This booking has already been refunded.', status: 400 };
          }

          // ------------------------------------------------------------
          // DEFENSIVE GUARD — prevents a double refund.
          //
          // If refund_attempted_at is set but chip_refund_id is missing,
          // the outcome at CHIP is UNKNOWN: the earlier attempt may have
          // succeeded but its response was lost, or the D1 batch write
          // failed after CHIP accepted the refund. Firing another refund
          // in that state risks refunding the same purchase twice.
          //
          // This mirrors the identical guard in owner-update-booking.js.
          // The admin must verify the purchase in the CHIP dashboard
          // before retrying. If CHIP shows no refund on the purchase,
          // support clears the marker (by removing refund_attempted_at
          // from the booking record in D1) and the retry can proceed.
          // ------------------------------------------------------------
          if (booking.refund_attempted_at && !booking.chip_refund_id) {
            return {
              error:
                `A refund for this booking was already attempted at ${booking.refund_attempted_at}` +
                ` by ${booking.refund_attempted_by || 'unknown'}` +
                ` for RM${Number(booking.refund_attempted_amount || 0).toFixed(2)}, but no refund` +
                ` ID was recorded. Log into the CHIP dashboard and check purchase` +
                ` ${booking.chip_purchase_id} for an existing refund before retrying. If CHIP` +
                ` shows no refund, contact support to clear the attempt marker on this booking.`,
              status: 409
            };
          }

          const status = String(booking.status || '');
          const isRefundableState =
            /refund pending|refund_pending|Refund Pending/i.test(status) ||
            (/cancelled by host/i.test(status) && !booking.chip_refund_id);
          if (!isRefundableState) {
            return {
              error: `Booking status "${status}" is not in a refund-pending state. Retry refund is only available for cancelled bookings whose refund did not go through.`,
              status: 400
            };
          }

          const secret = env.CHIP_SECRET_KEY;
          if (!secret) {
            return { error: 'CHIP_SECRET_KEY not configured. Cannot process refund.', status: 500 };
          }

          // Determine the correct refund amount from the stored cancel_type.
          // A missing cancel_type means this is a legacy booking created
          // before the two-path policy. Default to host_own (full refund),
          // the safer choice for the guest.
          const storedCancelType = String(booking.cancel_type || 'host_own').toLowerCase().trim();
          const effectiveCancelType = (storedCancelType === 'guest_request') ? 'guest_request' : 'host_own';

          const totalPaidNum = Number(booking.amount_paid || booking.total) || 0;
          const baseAmountNum = Number(booking.base) || 0;
          const refundAmountNum = effectiveCancelType === 'guest_request'
            ? baseAmountNum
            : totalPaidNum;
          const feeRetainedNum = Math.max(0, Math.round((totalPaidNum - refundAmountNum) * 100) / 100);

          if (refundAmountNum <= 0) {
            return { error: 'Computed refund amount is zero or negative. Cannot refund.', status: 400 };
          }

          bookings[idx].refund_attempted_at = new Date().toISOString();
          bookings[idx].refund_attempted_by = 'admin';
          bookings[idx].refund_attempted_amount = refundAmountNum;
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          const refundAmountCents = Math.round(refundAmountNum * 100);
          let refundData = null;
          let refundError = null;

          try {
            const resp = await fetch(
              `https://gate.chip-in.asia/api/v1/purchases/${booking.chip_purchase_id}/refund/`,
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
            try { data = await resp.json(); } catch (_) { data = null; }
            if (!resp.ok || !data || !data.id) {
              refundError = (data && (data.error || data.message)) || `HTTP ${resp.status}`;
            } else {
              refundData = data;
            }
          } catch (e) {
            refundError = e.message;
          }

          if (refundData) {
            const isPending = refundData.status === 'pending_refund';
            bookings[idx].status = isPending ? 'Refund Pending - Awaiting CHIP' : 'Refunded';
            bookings[idx].chip_refund_id = refundData.id;
            bookings[idx].refunded_at = new Date().toISOString();
            bookings[idx].refund_amount = refundAmountNum;
            bookings[idx].refund_pending = isPending;
            bookings[idx].statusUpdated = new Date().toISOString();
            delete bookings[idx].refund_error;
          } else {
            bookings[idx].status = 'Cancelled by Host - Refund Pending';
            bookings[idx].refund_error = refundError || 'Unknown error';
            bookings[idx].statusUpdated = new Date().toISOString();
          }

          // On a successful guest_request retry, write the retained fee
          // to the ledger — same rules as owner-update-booking.js.
          let feeEarningsToWrite = null;
          let feeRecordedAmount = 0;

          if (
            refundData &&
            effectiveCancelType === 'guest_request' &&
            feeRetainedNum > 0
          ) {
            try {
              const feeRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
              let feeEarnings = feeRes && feeRes.data
                ? JSON.parse(feeRes.data)
                : { total: 0, available: 0, withdrawn: 0, history: [] };
              feeEarnings.history = feeEarnings.history || [];

              const alreadyRecorded = feeEarnings.history.some(h =>
                h.bookingId === bookingId &&
                (h.type === 'earning' || h.type === 'cancellation_retained_fee')
              );

              if (!alreadyRecorded) {
                feeEarnings.total = Math.round(((feeEarnings.total || 0) + feeRetainedNum) * 100) / 100;
                feeEarnings.available = Math.round(((feeEarnings.available || 0) + feeRetainedNum) * 100) / 100;
                feeEarnings.history.push({
                  bookingId,
                  fee: feeRetainedNum,
                  date: new Date().toISOString(),
                  type: 'cancellation_retained_fee',
                  cancellation_type: 'guest_request',
                  original_amount_paid: totalPaidNum,
                  refunded_amount: refundAmountNum,
                  method: 'chip_collect_partial_refund_admin_retry',
                  ip: clientIP
                });
                feeEarningsToWrite = feeEarnings;
                feeRecordedAmount = feeRetainedNum;
              }
            } catch (feeReadErr) {
              console.error('Could not read fee earnings before admin retry batch:', feeReadErr.message);
              // Do not fail the response. The refund already happened at
              // CHIP. Log for manual reconciliation.
            }
          }

          // Atomic write: booking status (always) + fee ledger (when applicable).
          const atomicStmts = [
            db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_bookings', JSON.stringify(bookings))
          ];
          if (feeEarningsToWrite) {
            atomicStmts.push(
              db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
                .bind('kd_fee_earnings', JSON.stringify(feeEarningsToWrite))
            );
          }

          try {
            await db.batch(atomicStmts);
          } catch (batchErr) {
            console.error('Atomic batch write failed during admin refund retry:', batchErr.message);
            return {
              error: `Refund succeeded at CHIP but the booking and ledger could not be updated (${batchErr.message}). Booking left in "attempt marker only" state. Verify refund ${refundData?.id || ''} in the CHIP dashboard, then contact support to reconcile.`,
              status: 500
            };
          }

          return {
            success: true,
            refunded: !!refundData,
            refundPending: refundData && refundData.status === 'pending_refund',
            refundId: refundData?.id || null,
            refundError: refundError || null,
            cancelType: effectiveCancelType,
            refundAmount: refundAmountNum,
            feeRetained: feeRetainedNum,
            feeRecorded: feeRecordedAmount,
            booking: bookings[idx]
          };
        }, 60000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return jsonResponse({ error: 'Another operation is in progress. Please try again.' }, 429, request);
        }
        throw lockErr;
      }

      if (result.error) {
        return jsonResponse({ error: result.error }, result.status || 400, request);
      }

      await logAction({
        db,
        action: result.refunded ? 'admin_refund_retry_success' : 'admin_refund_retry_failed',
        admin: 'admin',
        details: `Admin retry refund for ${bookingId} (type=${result.cancelType || 'unknown'}): ${
          result.refunded
            ? `${result.refundId}, RM${Number(result.refundAmount || 0).toFixed(2)}`
            : result.refundError
        }. Retained fee recorded to ledger: RM${Number(result.feeRecorded || 0).toFixed(2)}.`,
        ip: clientIP,
        homestayId: result.booking?.homestayId
      });

      return jsonResponse(result, 200, request);
    }

    // ---- Admin: approveHomestay ----
    if (action === "approveHomestay" && body.id) {
      try {
        const pendingRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
        let pending = [];
        if (pendingRes && pendingRes.data) {
          try { pending = JSON.parse(pendingRes.data); } catch(e) {
            return jsonResponse({ error: 'Corrupt pending data' }, 500, request);
          }
        }
        const idx = pending.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return jsonResponse({ error: 'Pending homestay not found' }, 404, request);
        }
        const homestay = pending[idx];

        const verificationPublicIds = collectVerificationPublicIds(homestay);

        const {
          icImage, icOriginalName, icUploadDate, icPublicId,
          bankQRImage, bankQROriginalName, bankQRPublicId,
          pbtLicense, pbtLicensePublicId,
          ownerPasswordHash, ownerSalt, ownerPasswordAlgorithm, ownerPasswordVersion,
          ...safeHomestay
        } = homestay;
        safeHomestay.approved = true;
        safeHomestay.verified = true;
        pending.splice(idx, 1);

        const approvedRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
        let approved = [];
        if (approvedRes && approvedRes.data) {
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            return jsonResponse({ error: 'Corrupt approved data' }, 500, request);
          }
        }
        approved.push(safeHomestay);

        const homestaysRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_homestays').first();
        let allHomes = [];
        if (homestaysRes && homestaysRes.data) {
          try { allHomes = JSON.parse(homestaysRes.data); } catch(e) {}
        }
        const hIdx = allHomes.findIndex(h => String(h.id) === String(safeHomestay.id));
        if (hIdx !== -1) {
          const cleanHome = { ...allHomes[hIdx] };
          delete cleanHome.icImage;
          delete cleanHome.icOriginalName;
          delete cleanHome.icUploadDate;
          delete cleanHome.icPublicId;
          delete cleanHome.bankQRImage;
          delete cleanHome.bankQROriginalName;
          delete cleanHome.bankQRPublicId;
          delete cleanHome.pbtLicense;
          delete cleanHome.pbtLicensePublicId;
          delete cleanHome.ownerPasswordHash;
          delete cleanHome.ownerSalt;
          delete cleanHome.ownerPasswordAlgorithm;
          delete cleanHome.ownerPasswordVersion;
          cleanHome.approved = true;
          cleanHome.verified = true;
          allHomes[hIdx] = cleanHome;
        }

        await db.batch([
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)').bind('kd_pending', JSON.stringify(pending)),
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)').bind('kd_approved', JSON.stringify(approved)),
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)').bind('kd_homestays', JSON.stringify(allHomes))
        ]);

        await invalidateOwnerSessionsForHomestay(db, safeHomestay.id);

        let destroyReport = { attempted: 0, succeeded: 0, failed: 0 };
        if (verificationPublicIds.length > 0) {
          for (const pid of verificationPublicIds) {
            const r = await destroyCloudinaryImage(pid, env);
            destroyReport.attempted++;
            if (r.success) destroyReport.succeeded++;
            else destroyReport.failed++;
          }
        }

        let emailResult = { sent: false, error: 'not attempted' };
        try {
          emailResult = await sendApprovalEmail(safeHomestay, env);
        } catch (mailErr) {
          console.error('Approval email error:', mailErr.message);
          emailResult = { sent: false, error: mailErr.message };
        }

        await logAction({
          db,
          action: 'homestay_approved',
          admin: 'admin',
          details: `Approved homestay "${safeHomestay.name}" (ID: ${safeHomestay.id}) by ${safeHomestay.ownerName}. Cloudinary destroy: ${destroyReport.succeeded}/${destroyReport.attempted} verified images removed. Email: ${emailResult.sent ? 'sent' : 'failed — ' + (emailResult.error || 'unknown')}.`,
          ip: clientIP,
          userId: safeHomestay.ownerEmail,
          homestayId: safeHomestay.id
        });

        return jsonResponse({
          success: true,
          homestay: safeHomestay,
          emailSent: emailResult.sent,
          emailError: emailResult.sent ? undefined : emailResult.error
        }, 200, request);
      } catch (approveErr) {
        console.error('Approve homestay error:', approveErr.message);
        return jsonResponse({ error: 'Approval failed. Please try again later.' }, 500, request);
      }
    }

    // ---- Admin: rejectHomestay (with email) ----
    if (action === "rejectHomestay" && body.id) {
      const pendingRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
      let pending = [];
      if (pendingRes && pendingRes.data) {
        try { pending = JSON.parse(pendingRes.data); } catch(e) {}
      }
      const idx = pending.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return jsonResponse({ error: 'Pending homestay not found' }, 404, request);
      }
      const homestay = pending[idx];
      const reason = String(body.reason || '').slice(0, 500).trim();

      const allPublicIds = collectAllImagePublicIds(homestay);

      pending.splice(idx, 1);

      const homestaysRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_homestays').first();
      let allHomes = [];
      if (homestaysRes && homestaysRes.data) {
        try { allHomes = JSON.parse(homestaysRes.data); } catch(e) {}
      }
      const hIdx = allHomes.findIndex(h => String(h.id) === String(homestay.id));
      if (hIdx !== -1) {
        allHomes.splice(hIdx, 1);
      }

      await db.batch([
        db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_pending', JSON.stringify(pending)),
        db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_homestays', JSON.stringify(allHomes))
      ]);

      await invalidateOwnerSessionsForHomestay(db, homestay.id);

      const emailResult = await sendRejectionEmail(homestay, reason, env);

      let destroyReport = { attempted: 0, succeeded: 0, failed: 0 };
      if (allPublicIds.length > 0) {
        for (const pid of allPublicIds) {
          const r = await destroyCloudinaryImage(pid, env);
          destroyReport.attempted++;
          if (r.success) destroyReport.succeeded++;
          else destroyReport.failed++;
        }
      }

      await logAction({
        db,
        action: 'homestay_rejected',
        admin: 'admin',
        details: `Rejected homestay "${homestay.name}" (ID: ${homestay.id}). Reason: ${reason || '(none)'}. Email: ${emailResult.sent ? 'sent' : 'failed — ' + (emailResult.error || 'unknown')}. Cloudinary destroy: ${destroyReport.succeeded}/${destroyReport.attempted} images removed (IC, bank QR, PBT, property, room photos).`,
        ip: clientIP,
        userId: homestay.ownerEmail,
        homestayId: homestay.id
      });

      return jsonResponse({
        success: true,
        emailSent: emailResult.sent,
        emailError: emailResult.sent ? undefined : emailResult.error,
        imagesDeleted: destroyReport.succeeded,
        imagesAttempted: destroyReport.attempted
      }, 200, request);
    }

    // ---- Admin: removeApprovedHomestay ----
    if (action === "removeApprovedHomestay" && body.id) {
      try {
        const isDemo = body.isDemo === true;

        const approvedRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
        let approved = [];
        if (approvedRes && approvedRes.data) {
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            return jsonResponse({ error: 'Corrupt approved data' }, 500, request);
          }
        }

        const idx = approved.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return jsonResponse({ error: 'Approved homestay not found' }, 404, request);
        }

        const removed = approved[idx];
        approved.splice(idx, 1);

        const allPublicIds = collectAllImagePublicIds(removed);

        const homestaysRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_homestays').first();
        let allHomes = [];
        if (homestaysRes && homestaysRes.data) {
          try { allHomes = JSON.parse(homestaysRes.data); } catch(e) {}
        }
        const hIdx = allHomes.findIndex(h => String(h.id) === String(removed.id));
        if (hIdx !== -1) {
          allHomes.splice(hIdx, 1);
        }

        if (isDemo) {
          const demoRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_deleted_demo').first();
          let deletedDemo = [];
          if (demoRes && demoRes.data) {
            try { deletedDemo = JSON.parse(demoRes.data); } catch(e) {}
          }
          if (!Array.isArray(deletedDemo)) deletedDemo = [];
          if (!deletedDemo.includes(String(body.id))) {
            deletedDemo.push(String(body.id));
          }
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_deleted_demo', JSON.stringify(deletedDemo))
            .run();
        }

        await db.batch([
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_approved', JSON.stringify(approved)),
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_homestays', JSON.stringify(allHomes))
        ]);

        await invalidateOwnerSessionsForHomestay(db, removed.id);

        let destroyReport = { attempted: 0, succeeded: 0, failed: 0 };
        if (allPublicIds.length > 0) {
          for (const pid of allPublicIds) {
            const r = await destroyCloudinaryImage(pid, env);
            destroyReport.attempted++;
            if (r.success) destroyReport.succeeded++;
            else destroyReport.failed++;
          }
        }

        await logAction({
          db,
          action: 'homestay_removed',
          admin: 'admin',
          details: `Removed homestay "${removed.name}" (ID: ${removed.id}) from approved. Cloudinary destroy: ${destroyReport.succeeded}/${destroyReport.attempted} images removed.`,
          ip: clientIP,
          userId: removed.ownerEmail,
          homestayId: removed.id
        });

        return jsonResponse({ success: true, removed: removed }, 200, request);
      } catch (removeErr) {
        console.error('Remove homestay error:', removeErr.message);
        return jsonResponse({ error: 'Remove failed. Please try again later.' }, 500, request);
      }
    }

    // ---- Admin: deleteOwner ----
    if (action === "deleteOwner") {
      const ownerId = body.ownerId ? String(body.ownerId) : '';
      const email = body.email ? String(body.email).toLowerCase().trim() : '';
      const whatsapp = body.whatsapp ? String(body.whatsapp).replace(/[^0-9]/g, '') : '';

      if (!ownerId && !email && !whatsapp) {
        return jsonResponse({ error: 'Owner identifier is required' }, 400, request);
      }

      const approvedRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
      const pendingRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_pending').first();
      const homestaysRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_homestays').first();

      let approved = []; try { if (approvedRes?.data) approved = JSON.parse(approvedRes.data); } catch (_) {}
      let pending = []; try { if (pendingRes?.data) pending = JSON.parse(pendingRes.data); } catch (_) {}
      let allHomes = []; try { if (homestaysRes?.data) allHomes = JSON.parse(homestaysRes.data); } catch (_) {}

      const initialMatches = [...approved, ...pending].filter(h => {
        const hId = String(h.id || '');
        const hEmail = String(h.ownerEmail || '').toLowerCase().trim();
        const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
        if (ownerId && hId === ownerId) return true;
        if (email && hEmail === email) return true;
        if (whatsapp && hWa === whatsapp) return true;
        return false;
      });

      if (initialMatches.length === 0) {
        return jsonResponse({ error: 'Owner not found' }, 404, request);
      }

      const targetIds = new Set(initialMatches.map(h => String(h.id)));
      const targetEmails = new Set(
        initialMatches.map(h => String(h.ownerEmail || '').toLowerCase().trim()).filter(Boolean)
      );
      const targetWhatsapps = new Set(
        initialMatches.map(h => String(h.whatsapp || '').replace(/[^0-9]/g, '')).filter(Boolean)
      );

      const matches = (h) => {
        const hId = String(h.id || '');
        const hEmail = String(h.ownerEmail || '').toLowerCase().trim();
        const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
        if (targetIds.has(hId)) return true;
        if (hEmail && targetEmails.has(hEmail)) return true;
        if (hWa && targetWhatsapps.has(hWa)) return true;
        return false;
      };

      const removedApproved = approved.filter(matches);
      const removedPending = pending.filter(matches);

      approved = approved.filter(h => !matches(h));
      pending = pending.filter(h => !matches(h));
      allHomes = allHomes.filter(h => !matches(h));

      const ownersRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_owners').first();
      let owners = [];
      try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch (_) {}
      const beforeOwnersCount = owners.length;
      owners = owners.filter(o => {
        const oId = String(o.id || '');
        const oEmail = String(o.ownerEmail || '').toLowerCase().trim();
        const oWa = String(o.whatsapp || '').replace(/[^0-9]/g, '');
        if (ownerId && oId === ownerId) return false;
        if (email && oEmail === email) return false;
        if (whatsapp && oWa === whatsapp) return false;
        return true;
      });
      const removedOwnersCount = beforeOwnersCount - owners.length;

      await db.batch([
        db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_approved', JSON.stringify(approved)),
        db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_pending', JSON.stringify(pending)),
        db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_homestays', JSON.stringify(allHomes)),
        db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_owners', JSON.stringify(owners))
      ]);

      for (const h of [...removedApproved, ...removedPending]) {
        try { await invalidateOwnerSessionsForHomestay(db, h.id); } catch (_) {}
      }

      await logAction({
        db,
        action: 'owner_deleted',
        admin: 'admin',
        details: `Deleted owner (id=${ownerId}, email=${email}) — removed ${removedApproved.length} approved + ${removedPending.length} pending homestays + ${removedOwnersCount} owner account(s)`,
        ip: clientIP,
        userId: email || ownerId
      });

      return jsonResponse({
        success: true,
        removedHomes: {
          approved: removedApproved.length,
          pending: removedPending.length
        },
        removedOwnerAccounts: removedOwnersCount,
        removedIds: [...targetIds]
      }, 200, request);
    }

    // ---- Admin: deleteGuest ----
    if (action === "deleteGuest") {
      const guestId = body.guestId ? String(body.guestId) : '';
      const email = body.email ? String(body.email).toLowerCase().trim() : '';

      if (!guestId && !email) {
        return jsonResponse({ error: 'Guest ID or email is required' }, 400, request);
      }

      const guestRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
      let guests = [];
      if (guestRes?.data) { try { guests = JSON.parse(guestRes.data); } catch (_) {} }

      const deleted = guests.find(g =>
        (guestId && String(g.id) === guestId) ||
        (email && String(g.email || '').toLowerCase().trim() === email)
      );

      if (!deleted) {
        return jsonResponse({ error: 'Guest not found' }, 404, request);
      }

      const deletedEmail = String(deleted.email || '').toLowerCase().trim();
      const deletedId = String(deleted.id || '');
      const remainingGuests = guests.filter(g => {
        const sameId = deletedId && String(g.id || '') === deletedId;
        const sameEmail = deletedEmail && String(g.email || '').toLowerCase().trim() === deletedEmail;
        return !sameId && !sameEmail;
      });

      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_guests', JSON.stringify(remainingGuests)).run();

      await logAction({
        db,
        action: 'guest_deleted',
        admin: 'admin',
        details: `Deleted guest ${deletedEmail || deletedId}`,
        ip: clientIP,
        userId: deletedId || deletedEmail
      });

      return jsonResponse({
        success: true,
        deleted: { id: deletedId, email: deletedEmail }
      }, 200, request);
    }

    // ---- Admin: updateHomestays (bulk sync) ----
    if (action === "updateHomestays") {
      const { approved, demoOverrides, demoBlocked, deletedDemo } = body;

      if (!Array.isArray(approved)) {
        return jsonResponse({ error: 'Invalid approved data' }, 400, request);
      }

      for (const h of approved) {
        if (!h || typeof h !== 'object' || !h.id || !h.name) {
          return jsonResponse({ error: 'Invalid homestay entry in approved array' }, 400, request);
        }
      }

      const oldApprovedRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_approved').first();
      let oldApproved = [];
      try { if (oldApprovedRes?.data) oldApproved = JSON.parse(oldApprovedRes.data); } catch (_) {}

      const oldById = new Map();
      for (const h of oldApproved) oldById.set(String(h.id), h);

      const incomingById = new Map();
      for (const h of approved) incomingById.set(String(h.id), h);

      let cacheClearedCount = 0;
      for (const h of approved) {
        const old = oldById.get(String(h.id));
        if (!old) continue;
        const oldCode = (old.bankCode || '').toUpperCase().trim();
        const oldAcct = (old.ownerBankAccount || '').replace(/[^0-9]/g, '');
        const oldHolder = (old.bankHolder || '').trim().toLowerCase();
        const newCode = (h.bankCode || '').toUpperCase().trim();
        const newAcct = (h.ownerBankAccount || '').replace(/[^0-9]/g, '');
        const newHolder = (h.bankHolder || '').trim().toLowerCase();
        const changed = oldCode !== newCode || oldAcct !== newAcct || oldHolder !== newHolder;
        if (changed) {
          delete h.chip_bank_account_id;
          cacheClearedCount++;
        }
      }

      const merged = [];
      for (const old of oldApproved) {
        const idKey = String(old.id);
        if (incomingById.has(idKey)) {
          merged.push(incomingById.get(idKey));
          incomingById.delete(idKey);
        } else {
          merged.push(old);
        }
      }
      for (const leftover of incomingById.values()) {
        merged.push(leftover);
      }

      const stmts = [];
      stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_approved', JSON.stringify(merged)));

      if (demoOverrides !== undefined) {
        stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_demo_overrides', JSON.stringify(demoOverrides)));
      }
      if (demoBlocked !== undefined) {
        stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_demo_blocked', JSON.stringify(demoBlocked)));
      }
      if (deletedDemo !== undefined) {
        stmts.push(db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_deleted_demo', JSON.stringify(deletedDemo)));
      }

      await db.batch(stmts);

      await logAction({
        db,
        action: 'homestays_updated',
        admin: 'admin',
        details: `Merged ${approved.length} incoming homestays against ${oldApproved.length} existing (final: ${merged.length}; cleared cached bank account on ${cacheClearedCount} due to bank-detail change)`,
        ip: clientIP,
        userId: 'admin'
      });

      return jsonResponse({ success: true, approved: merged }, 200, request);
    }

    return jsonResponse({ success: true, message: 'Synced' }, 200, request);

  } catch (err) {
    console.error('Bookings POST admin action error:', err.message);
    return jsonResponse({ error: 'An internal error occurred. Please try again later.' }, 500, request);
  }
}

// ============================================================
// DELETE (single booking)
// ============================================================
export async function onRequestDelete({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return jsonResponse({ error: 'Missing booking id' }, 400, request);
  }

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
  await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

  let result;
  try {
    result = await withLock(db, BOOKINGS_LOCK, async (db) => {
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
      let bookings = [];
      try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
      const idx = bookings.findIndex(b => String(b.id) === String(id));
      if (idx === -1) return { error: 'Booking not found', status: 404 };
      const deleted = bookings[idx];
      bookings.splice(idx, 1);
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      return { success: true, deleted };
    }, 30000);
  } catch (lockErr) {
    if (lockErr.message && lockErr.message.includes('in progress')) {
      return jsonResponse({ error: 'Another booking operation is in progress. Please try again in a moment.' }, 429, request);
    }
    throw lockErr;
  }

  if (result.error) {
    return jsonResponse({ error: result.error }, result.status || 400, request);
  }

  await logAction({
    db,
    action: 'booking_deleted_admin',
    admin: 'admin',
    details: `Deleted booking ${id} (${result.deleted.homestay})`,
    ip: getClientIP(request),
    userId: result.deleted.guestId,
    homestayId: result.deleted.homestayId
  });

  return jsonResponse({ success: true, deleted: result.deleted }, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
