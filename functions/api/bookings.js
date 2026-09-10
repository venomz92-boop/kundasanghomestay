// /api/bookings.js – FULLY PATCHED with unified fee + clearAll + approve cleanup + public data sanitization + deleteOwner + Cloudinary cleanup + status emails + failed-payment cooldown (measured from statusUpdated)
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  validateCSRFToken,
  getCSRFToken,
  getGuestSession,
  getAdminToken,
  jsonResponse,
  parseJSONSafely,
  withLock,
  checkRateLimit,
  recordRateLimit,
  invalidateOwnerSessions
} from './_utils.js';

const MAX_NIGHTS = 60;
const DEFAULT_PAGE_SIZE = 50;
const GATEWAY_FEE = 1.00;
const FAILED_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes from last status change

// ============================================================
// Helper: latest status change timestamp for a booking
// Uses statusUpdated when present, falls back to date for legacy records
// ============================================================
function getLastStatusChangeTime(b) {
  const d = b.date ? Date.parse(b.date) : 0;
  const s = b.statusUpdated ? Date.parse(b.statusUpdated) : 0;
  const max = Math.max(d || 0, s || 0);
  return Number.isFinite(max) ? max : 0;
}

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

// ============================================================
// Cloudinary cleanup helpers
// ============================================================
function extractPublicIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const marker = '/upload/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  let rest = url.slice(idx + marker.length);
  rest = rest.replace(/^v\d+\//, '');
  rest = rest.replace(/\.[a-zA-Z0-9]+$/, '');
  return rest || null;
}

async function deleteCloudinaryImages(urls, env) {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    console.warn('Cloudinary credentials missing – cannot delete sensitive images');
    return { deleted: [], failed: [] };
  }

  const publicIds = urls.map(extractPublicIdFromUrl).filter(Boolean);
  if (publicIds.length === 0) return { deleted: [], failed: [] };

  const auth = btoa(`${apiKey}:${apiSecret}`);
  const deleted = [];
  const failed = [];

  for (const publicId of publicIds) {
    try {
      const res = await fetch(
        `https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload?public_ids=${encodeURIComponent(publicId)}`,
        {
          method: 'DELETE',
          headers: { 'Authorization': `Basic ${auth}` }
        }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        deleted.push(publicId);
      } else {
        failed.push({ publicId, error: data?.error?.message || res.statusText });
        console.warn(`Cloudinary delete failed for ${publicId}:`, data);
      }
    } catch (e) {
      failed.push({ publicId, error: e.message });
      console.warn(`Cloudinary delete threw for ${publicId}:`, e.message);
    }
  }

  return { deleted, failed };
}

async function purgeSensitiveImages(homestay, env, logContext) {
  if (!homestay) return { deleted: [], failed: [] };
  const urls = [
    homestay.icImage,
    homestay.bankQRImage,
    homestay.pbtLicense
  ].filter(Boolean);

  if (urls.length === 0) return { deleted: [], failed: [] };

  const result = await deleteCloudinaryImages(urls, env);
  console.log(
    `[${logContext}] Purged ${result.deleted.length}/${urls.length} sensitive images` +
    (result.failed.length ? ` (${result.failed.length} failed)` : '')
  );
  return result;
}

// ============================================================
// Email notification helper – Resend + SendGrid fallback
// ============================================================
async function sendStatusEmail({ to, subject, html, env, logContext }) {
  if (!to) {
    console.warn(`[${logContext}] No recipient email – skipping notification`);
    return { sent: false, error: 'no recipient' };
  }

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
          to, subject, html
        })
      });
      if (r.ok) {
        console.log(`[${logContext}] Email sent via Resend to ${to}`);
        return { sent: true };
      }
      const errBody = await r.text().catch(() => '');
      console.warn(`[${logContext}] Resend error ${r.status}: ${errBody.slice(0, 200)}`);
    }

    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject,
          content: [{ type: 'text/html', value: html }]
        })
      });
      if (r.ok) {
        console.log(`[${logContext}] Email sent via SendGrid to ${to}`);
        return { sent: true };
      }
      console.warn(`[${logContext}] SendGrid error ${r.status}`);
      return { sent: false, error: `SendGrid ${r.status}` };
    }

    console.warn(`[${logContext}] No email provider configured`);
    return { sent: false, error: 'no email provider configured' };
  } catch (e) {
    console.warn(`[${logContext}] Email threw: ${e.message}`);
    return { sent: false, error: e.message };
  }
}

function approvedEmailHtml({ ownerName, homestayName, location, price, id, env }) {
  const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
  const year = new Date().getFullYear();
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f5f0; padding: 20px; border-radius: 16px;">
      <div style="background: #ffffff; padding: 32px; border-radius: 16px; border: 1px solid #e5e7eb;">
        <div style="text-align: center; margin-bottom: 20px;">
          <div style="display: inline-block; width: 64px; height: 64px; background: #dcfce7; border-radius: 999px; line-height: 64px; font-size: 32px;">✅</div>
        </div>
        <h1 style="text-align: center; font-size: 22px; color: #0F382E; margin: 0 0 6px 0; font-weight: 700;">Your listing is live!</h1>
        <p style="text-align: center; color: #6b7280; font-size: 13px; margin: 0 0 24px 0;">Approved and now visible to guests</p>

        <p style="font-size: 14px; line-height: 1.6; color: #374151; margin: 0 0 12px 0;">Hi <strong>${ownerName || 'Host'}</strong>,</p>
        <p style="font-size: 14px; line-height: 1.6; color: #374151; margin: 0 0 20px 0;">Great news! Your property has been verified and approved. Guests browsing Kundasang Homestay can now find and book it.</p>

        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px; margin: 20px 0;">
          <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #166534; font-weight: 700; margin-bottom: 10px;">Listing Details</div>
          <div style="font-size: 13px; color: #374151; line-height: 1.8;">
            <div><strong>Property:</strong> ${homestayName}</div>
            <div><strong>Location:</strong> ${location}</div>
            <div><strong>Nightly Rate:</strong> RM ${price}</div>
            <div><strong>Listing ID:</strong> <span style="font-family: monospace;">${id}</span></div>
          </div>
        </div>

        <p style="font-size: 14px; line-height: 1.6; color: #374151;">You can now log in to your dashboard to manage dates, pricing, and reservations.</p>

        <div style="text-align: center; margin: 28px 0 8px;">
          <a href="${domain}/owner.html" style="display: inline-block; padding: 14px 28px; background: #0F382E; color: #ffffff; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 13px; letter-spacing: 0.05em;">Open Host Dashboard →</a>
        </div>

        <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; text-align: center; font-size: 11px; color: #9ca3af; line-height: 1.6;">
          Kundasang Homestay • Verified Stays with Kinabalu Views<br>
          © ${year} Nick's Creations • Business License RNU20183012
        </div>
      </div>
    </div>
  `;
}

function rejectedEmailHtml({ ownerName, homestayName, reason, env }) {
  const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
  const year = new Date().getFullYear();
  const reasonBlock = reason
    ? `
      <div style="background: #fef3c7; border: 1px solid #fde68a; border-radius: 12px; padding: 16px; margin: 20px 0;">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #92400e; font-weight: 700; margin-bottom: 8px;">Reason from our team</div>
        <div style="font-size: 13px; color: #374151; line-height: 1.6;">${reason}</div>
      </div>
    `
    : '';

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f5f0; padding: 20px; border-radius: 16px;">
      <div style="background: #ffffff; padding: 32px; border-radius: 16px; border: 1px solid #e5e7eb;">
        <div style="text-align: center; margin-bottom: 20px;">
          <div style="display: inline-block; width: 64px; height: 64px; background: #fee2e2; border-radius: 999px; line-height: 64px; font-size: 32px;">📋</div>
        </div>
        <h1 style="text-align: center; font-size: 22px; color: #991b1b; margin: 0 0 6px 0; font-weight: 700;">Update on your listing</h1>
        <p style="text-align: center; color: #6b7280; font-size: 13px; margin: 0 0 24px 0;">We couldn't approve it this time</p>

        <p style="font-size: 14px; line-height: 1.6; color: #374151; margin: 0 0 12px 0;">Hi <strong>${ownerName || 'Host'}</strong>,</p>
        <p style="font-size: 14px; line-height: 1.6; color: #374151; margin: 0 0 20px 0;">Thank you for submitting your property <strong>${homestayName}</strong>. After reviewing your submission, we're unable to approve it at this time.</p>

        ${reasonBlock}

        <div style="font-size: 13px; color: #374151; line-height: 1.8; margin: 20px 0;">
          <div style="font-weight: 700; margin-bottom: 6px;">What you can do:</div>
          <ul style="margin: 0; padding-left: 20px;">
            <li>Reply to this email if you'd like clarification</li>
            <li>Correct any issues and submit again via our host registration form</li>
            <li>Contact our support team for assistance</li>
          </ul>
        </div>

        <div style="text-align: center; margin: 28px 0 8px;">
          <a href="${domain}/list.html" style="display: inline-block; padding: 14px 28px; background: #0F382E; color: #ffffff; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 13px; letter-spacing: 0.05em;">Resubmit Listing →</a>
        </div>

        <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; text-align: center; font-size: 11px; color: #9ca3af; line-height: 1.6;">
          Kundasang Homestay • Verified Stays with Kinabalu Views<br>
          © ${year} Nick's Creations • Business License RNU20183012
        </div>
      </div>
    </div>
  `;
}

function removedEmailHtml({ ownerName, homestayName, env }) {
  const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
  const year = new Date().getFullYear();
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f5f0; padding: 20px; border-radius: 16px;">
      <div style="background: #ffffff; padding: 32px; border-radius: 16px; border: 1px solid #e5e7eb;">
        <div style="text-align: center; margin-bottom: 20px;">
          <div style="display: inline-block; width: 64px; height: 64px; background: #fef3c7; border-radius: 999px; line-height: 64px; font-size: 32px;">⚠️</div>
        </div>
        <h1 style="text-align: center; font-size: 22px; color: #92400e; margin: 0 0 6px 0; font-weight: 700;">Your listing was removed</h1>
        <p style="text-align: center; color: #6b7280; font-size: 13px; margin: 0 0 24px 0;">It's no longer visible to guests</p>

        <p style="font-size: 14px; line-height: 1.6; color: #374151; margin: 0 0 12px 0;">Hi <strong>${ownerName || 'Host'}</strong>,</p>
        <p style="font-size: 14px; line-height: 1.6; color: #374151; margin: 0 0 20px 0;">Your listing <strong>${homestayName}</strong> has been removed from Kundasang Homestay by our administrative team. It is no longer shown to guests.</p>

        <p style="font-size: 14px; line-height: 1.6; color: #374151;">If you believe this was done in error, or you'd like to discuss the removal, please reply to this email.</p>

        <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; text-align: center; font-size: 11px; color: #9ca3af; line-height: 1.6;">
          Kundasang Homestay • Verified Stays with Kinabalu Views<br>
          © ${year} Nick's Creations • Business License RNU20183012
        </div>
      </div>
    </div>
  `;
}

async function verifyAdmin(request, env) {
  const auth = await getAdminToken(request);
  if (!env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers: corsHeaders(request) });
  if (auth !== env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders(request) });
  return null;
}

async function requireGuest(request, env, body) {
  const session = await getGuestSession(request, env);
  if (!session || session.type !== 'guest') return { error: jsonResponse({ error: 'Authentication required' }, 401, request) };
  const guestId = body?.booking?.guestId || body?.guestId;
  if (guestId && String(guestId) !== String(session.userId)) return { error: jsonResponse({ error: 'Guest identity mismatch' }, 403, request) };
  const csrf = getCSRFToken(request);
  if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) return { error: jsonResponse({ error: 'Invalid security token' }, 403, request) };
  return { session };
}

function sanitizePublicHomestay(h) {
  if (!h) return null;
  const {
    id, name, location, description, image, images, rooms,
    ownerPrice, guests, bedrooms, rating, reviews, verified, approved, blockedDates
  } = h;
  return {
    id, name, location, description, image, images,
    rooms: Array.isArray(rooms) ? rooms.map(r => ({
      id: r.id,
      name: r.name,
      price: r.price,
      guests: r.guests,
      desc: r.desc,
      images: r.images || [],
      blockedDates: r.blockedDates || []
    })) : [],
    ownerPrice, guests, bedrooms, rating, reviews, verified, approved,
    blockedDates: Array.isArray(blockedDates) ? blockedDates : []
  };
}

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const guestSession = await getGuestSession(request, env);
    const adminToken = await getAdminToken(request);
    const isAdmin = adminToken && adminToken === env.ADMIN_TOKEN;

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

    if (isAdmin) {
      const paginated = bookings.slice(offset, offset + limit);

      let ownersList = [];
      try {
        const ownersRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_owners').first();
        if (ownersRes?.data) ownersList = JSON.parse(ownersRes.data);
      } catch (_) {}

      return jsonResponse({
        bookings: paginated,
        total: bookings.length,
        page,
        limit,
        totalPages: Math.ceil(bookings.length / limit),
        approved,
        demoOverrides,
        demoBlocked,
        deletedDemo,
        pending,
        owners: ownersList.map(o => {
          const {
            ownerPasswordHash, ownerSalt, ownerPasswordAlgorithm,
            ownerPasswordVersion, ownerSessionVersion, ...safe
          } = o;
          return safe;
        }),
        guests: guests.map(g => { const { password, salt, ...safe } = g; return safe; })
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

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

    const sanitizedApproved = approved.map(sanitizePublicHomestay).filter(Boolean);

    const availability = {};
    for (const h of approved) {
      const homestayId = String(h.id);
      availability[homestayId] = bookings
        .filter(b => String(b.homestayId) === homestayId && !/cancelled|failed|expired/i.test(String(b.status || '')))
        .flatMap(b => getDatesInRange(b.checkin, b.checkout));
    }

    return jsonResponse({ approved: sanitizedApproved, availability }, 200, request, {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
    });

  } catch (e) {
    console.error('Bookings GET error:', e.message);
    return jsonResponse({ error: 'Failed to load bookings' }, 500, request);
  }
}

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

  // ========== PUBLIC ACTIONS ==========
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

    const approvedRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
    let approved = [];
    try { if (approvedRes?.data) approved = JSON.parse(approvedRes.data); } catch(_) {}
    const homestay = approved.find(h => String(h.id) === homestayId && h.approved === true);
    if (!homestay) return jsonResponse({ error: 'Homestay not found or not approved' }, 404, request);

    let selectedRoom = null;
    const rooms = homestay.rooms || [];
    if (roomId) {
      selectedRoom = rooms.find(r => String(r.id) === roomId);
      if (!selectedRoom) return jsonResponse({ error: 'Selected room not found' }, 400, request);
    }
    const ownerPrice = selectedRoom ? parseFloat(selectedRoom.price) : homestay.ownerPrice;
    if (!Number.isFinite(ownerPrice) || ownerPrice <= 0) {
      return jsonResponse({ error: 'Invalid price configuration' }, 500, request);
    }

    try {
      const result = await withLock(db, homestayId, async (db) => {
        const bookingsRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
        let allBookings = [];
        try { if (bookingsRes?.data) allBookings = JSON.parse(bookingsRes.data); } catch(_) {}

        const guestsRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
        let guests = [];
        try { if (guestsRes?.data) guests = JSON.parse(guestsRes.data); } catch(_) {}

        const guest = guests.find(g => String(g.id) === String(auth.session.userId));
        if (!guest) {
          throw new Error('Guest not found');
        }

        // ===== existingPending: same guest, same dates =====
        const existingPending = allBookings.find(b => {
          if (String(b.guestId) !== String(guest.id)) return false;
          if (String(b.homestayId) !== String(homestay.id)) return false;
          if (b.checkin !== checkin || b.checkout !== checkout) return false;

          if (b.status === 'Pending Payment') return true;

          if (b.status === 'Payment Failed') {
            const lastChange = getLastStatusChangeTime(b);
            if (lastChange && (Date.now() - lastChange < FAILED_COOLDOWN_MS)) return true;
          }
          return false;
        });

        if (existingPending) {
          if (existingPending.status === 'Payment Failed') {
            existingPending.status = 'Pending Payment';
            existingPending.date = new Date().toISOString();
            existingPending.statusUpdated = new Date().toISOString();

            await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_bookings', JSON.stringify(allBookings))
              .run();
          }
          return { alreadyExists: true, booking: existingPending };
        }

        const homestayBlocked = new Set((homestay.blockedDates || []).map(String));
        const requestedDates = getDatesInRange(checkin, checkout);
        for (const ds of requestedDates) {
          if (homestayBlocked.has(ds)) {
            throw new Error(`Selected dates are unavailable (${ds}) due to homestay block`);
          }
        }

        if (selectedRoom) {
          const roomBlocked = new Set((selectedRoom.blockedDates || []).map(String));
          for (const ds of requestedDates) {
            if (roomBlocked.has(ds)) {
              throw new Error(`Room "${selectedRoom.name}" is blocked on ${ds}`);
            }
          }
        }

        const overlaps = allBookings.some(b => {
          const lastChange = getLastStatusChangeTime(b);
          const ageMs = lastChange ? (Date.now() - lastChange) : Number.MAX_SAFE_INTEGER;

          const pendingExpired = String(b.status||'') === 'Pending Payment'
            && ageMs > FAILED_COOLDOWN_MS;

          const failedActive = String(b.status||'') === 'Payment Failed'
            && ageMs < FAILED_COOLDOWN_MS;

          const isTerminal = /cancelled|expired/i.test(String(b.status||'')) && !failedActive;

          const isOwnPending = String(b.guestId) === String(guest.id) &&
            (b.status === 'Pending Payment' || b.status === 'Payment Failed');

          const roomMatch = selectedRoom
            ? String(b.roomId) === String(selectedRoom.id)
            : String(b.homestayId) === String(homestay.id);

          return roomMatch &&
                 !pendingExpired &&
                 !isTerminal &&
                 !isOwnPending &&
                 checkin < String(b.checkout||'') &&
                 checkout > String(b.checkin||'');
        });
        if (overlaps) {
          throw new Error('Selected dates are already booked for this room');
        }

        const base = Math.round(ownerPrice * nights * 100) / 100;
        const fee = Math.round(base * 0.11 * 100) / 100;
        const gatewayFee = GATEWAY_FEE;
        const total = Math.round((base + fee + gatewayFee) * 100) / 100;
        let bookingId = String(incoming.id || '');
        if (!/^KDH-[A-Za-z0-9_-]{4,40}$/.test(bookingId) || allBookings.some(b=>String(b.id)===bookingId)) {
          bookingId = `KDH-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
        }
        const checkinCode = String(Math.floor(100000 + Math.random() * 900000));
        const nowIso = new Date().toISOString();

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
          date: nowIso,
          statusUpdated: nowIso,
          checkinCode: checkinCode,
          roomId: selectedRoom ? selectedRoom.id : null,
          roomName: selectedRoom ? selectedRoom.name : null,
          roomImages: selectedRoom ? (selectedRoom.images || []) : []
        };

        allBookings.push(booking);

        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(allBookings))
          .run();

        return { booking };
      });

      if (result.alreadyExists) {
        return jsonResponse({
          success: true,
          booking: result.booking,
          alreadyExists: true,
          message: 'You already have a pending booking for these dates. Please complete the payment.'
        }, 200, request);
      }

      const booking = result.booking;

      await logAction({
        db,
        action: 'booking_created',
        admin: 'guest',
        details: `Booking ${booking.id} created; payment pending`,
        ip: clientIP,
        userId: booking.guestId,
        homestayId: booking.homestayId
      });

      return jsonResponse({ success: true, booking: booking }, 200, request);

    } catch (err) {
      console.error('Create booking error:', err.message);
      return jsonResponse({ error: 'This date is already booked.' }, 500, request);
    }
  }

  // ========== PUBLIC UPDATE STATUS ==========
  if (action === "publicUpdateStatus" && body.id) {
    const auth = await requireGuest(request, env, body);
    if (auth.error) return auth.error;

    const allowedStatuses = ['Cancelled by Guest', 'Payment Failed'];
    if (!allowedStatuses.includes(body.status)) {
      return jsonResponse({ error: 'Guests may only cancel or mark as failed.' }, 403, request);
    }

    const db = env.DB; if (!db) return jsonResponse({error:'DB not configured'},500,request);
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
      const r=await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
      let bookings=[]; try{if(r?.data)bookings=JSON.parse(r.data)}catch(_){}
      const idx=bookings.findIndex(b=>String(b.id)===String(body.id));
      if(idx<0) return jsonResponse({ error: 'Invalid request.' }, 400, request);
      const b=bookings[idx];
      if(String(b.guestId)!==String(auth.session.userId)) return jsonResponse({ error: 'Unauthorized' }, 403, request);

      if (body.status === 'Cancelled by Guest') {
        const paidStatuses = ['Paid - Awaiting Check-in', 'Completed'];
        if (paidStatuses.includes(b.status)) {
          return jsonResponse({ error: 'You cannot cancel a booking that has already been paid. Please contact support.' }, 403, request);
        }
        const today = new Date();
        today.setHours(0,0,0,0);
        const checkinDate = new Date(b.checkin + 'T00:00:00');
        if (checkinDate <= today) {
          return jsonResponse({ error: 'You cannot cancel a booking on or after the check‑in date.' }, 403, request);
        }
      }

      // ===== IMPORTANT: refresh statusUpdated so the cooldown window starts now =====
      const nowIso = new Date().toISOString();
      bookings[idx] = {
        ...b,
        status: body.status,
        statusUpdated: nowIso,
        // For Payment Failed, also refresh date so downstream tools that
        // read only `date` still see a fresh timestamp.
        date: body.status === 'Payment Failed' ? nowIso : b.date
      };

      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings',JSON.stringify(bookings)).run();

      await logAction({
        db,
        action:'public_status_updated',
        admin:'guest',
        details:`Booking ${b.id} status updated to ${body.status}`,
        ip:clientIP,
        userId:b.guestId,
        homestayId:b.homestayId
      });

      return jsonResponse({success:true,booking:bookings[idx]},200,request);
    } catch(e) {
      console.error('Guest status update error:', e.message);
      return jsonResponse({ error: 'Could not update booking' }, 500, request);
    }
  }

  // ========== ADMIN ACTIONS ==========
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders(request) });
  }

  const adminIP = getClientIP(request);
  const rateOk = await checkRateLimit(db, adminIP, 'admin_action', 100, 60);
  if (!rateOk) {
    return jsonResponse({ error: 'Too many admin actions. Please slow down.' }, 429, request);
  }
  await recordRateLimit(db, adminIP, 'admin_action');

  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // ---- Admin: clearAll ----
    if (action === "clearAll") {
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify([]))
        .run();
      await logAction({
        db,
        action: 'bookings_cleared',
        admin: 'admin',
        details: 'All bookings cleared via clearAll action',
        ip: clientIP
      });
      return jsonResponse({ success: true, bookings: [] }, 200, request);
    }

    // ---- Admin updateStatus ----
    if (action === "updateStatus" && body.id) {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = [];
      if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
      const idx = bookings.findIndex(b => String(b.id) === String(body.id));
      if (idx === -1) {
        return jsonResponse({ error: "Booking not found" }, 404, request);
      }
      const nowIso = new Date().toISOString();
      bookings[idx].status = body.status;
      bookings[idx].statusUpdated = nowIso;
      if (body.booking) {
        bookings[idx] = { ...bookings[idx], ...body.booking };
      }
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();

      await logAction({
        db,
        action: 'booking_status_updated',
        admin: 'admin',
        details: `Booking ${body.id} status changed to ${body.status}`,
        ip: clientIP,
        userId: bookings[idx].guestEmail,
        homestayId: bookings[idx].homestayId
      });

      return jsonResponse({ success: true, booking: bookings[idx] }, 200, request);
    }

    // ---- Admin updateDates ----
    if (action === "updateDates" && body.id) {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      let bookings = [];
      if (r && r.data) { try { bookings = JSON.parse(r.data); } catch(e) {} }
      const idx = bookings.findIndex(b => String(b.id) === String(body.id));
      if (idx === -1) {
        return jsonResponse({ error: "Booking not found" }, 404, request);
      }
      bookings[idx].checkin = body.checkin;
      bookings[idx].checkout = body.checkout;
      bookings[idx].nights = body.nights;
      bookings[idx].base = body.base;
      bookings[idx].fee = body.fee;
      bookings[idx].total = body.total;
      bookings[idx].youReceive = body.youReceive;
      bookings[idx].statusUpdated = new Date().toISOString();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();

      await logAction({
        db,
        action: 'booking_dates_changed',
        admin: 'admin',
        details: `Booking ${body.id} dates changed to ${body.checkin}→${body.checkout}`,
        ip: clientIP,
        userId: bookings[idx].guestEmail,
        homestayId: bookings[idx].homestayId
      });

      return jsonResponse({ success: true, booking: bookings[idx] }, 200, request);
    }

    // ---- Admin approveHomestay ----
    if (action === "approveHomestay" && body.id) {
      try {
        const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
        let pending = [];
        if (pendingRes && pendingRes.data) {
          try { pending = JSON.parse(pendingRes.data); } catch(e) {
            return jsonResponse({ error: "Corrupt pending data" }, 500, request);
          }
        }
        const idx = pending.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return jsonResponse({ error: "Pending homestay not found" }, 404, request);
        }
        const homestay = pending[idx];

        await purgeSensitiveImages(homestay, env, `approveHomestay:${homestay.id}`);

        const {
          icImage, icOriginalName, bankQRImage, bankQROriginalName, pbtLicense,
          icNumber, icUploadDate,
          ...safeHomestay
        } = homestay;
        safeHomestay.approved = true;
        safeHomestay.verified = true;
        pending.splice(idx, 1);

        const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
        let approved = [];
        if (approvedRes && approvedRes.data) {
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            return jsonResponse({ error: "Corrupt approved data" }, 500, request);
          }
        }
        approved.push(safeHomestay);

        const homestaysRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_homestays").first();
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
          delete cleanHome.icNumber;
          delete cleanHome.bankQRImage;
          delete cleanHome.bankQROriginalName;
          delete cleanHome.pbtLicense;
          delete cleanHome.ownerPasswordHash;
          delete cleanHome.ownerSalt;
          delete cleanHome.ownerPasswordAlgorithm;
          delete cleanHome.ownerPasswordVersion;
          cleanHome.approved = true;
          cleanHome.verified = true;
          allHomes[hIdx] = cleanHome;
        }

        const stmt1 = db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_pending", JSON.stringify(pending));
        const stmt2 = db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_approved", JSON.stringify(approved));
        const stmt3 = db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_homestays", JSON.stringify(allHomes));
        await db.batch([stmt1, stmt2, stmt3]);

        await invalidateOwnerSessions(db, safeHomestay.id);

        await logAction({
          db,
          action: 'homestay_approved',
          admin: 'admin',
          details: `Approved homestay "${safeHomestay.name}" (ID: ${safeHomestay.id}) by ${safeHomestay.ownerName}`,
          ip: clientIP,
          userId: safeHomestay.ownerEmail,
          homestayId: safeHomestay.id
        });

        let emailResult = { sent: false };
        if (safeHomestay.ownerEmail) {
          const html = approvedEmailHtml({
            ownerName: safeHomestay.ownerName || safeHomestay.icName,
            homestayName: safeHomestay.name,
            location: safeHomestay.location,
            price: safeHomestay.ownerPrice,
            id: safeHomestay.id,
            env
          });
          emailResult = await sendStatusEmail({
            to: safeHomestay.ownerEmail,
            subject: `✅ Your listing "${safeHomestay.name}" is now live on Kundasang Homestay`,
            html, env,
            logContext: `approveHomestay:${safeHomestay.id}`
          });
        }

        return jsonResponse({
          success: true,
          homestay: safeHomestay,
          emailSent: emailResult.sent === true,
          emailError: emailResult.sent === true ? undefined : emailResult.error
        }, 200, request);
      } catch (approveErr) {
        console.error("Approve homestay error:", approveErr.message);
        return jsonResponse({ error: "Approval failed. Please try again later." }, 500, request);
      }
    }

    // ---- Admin rejectHomestay ----
    if (action === "rejectHomestay" && body.id) {
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';

      const pendingRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      let pending = [];
      if (pendingRes && pendingRes.data) { try { pending = JSON.parse(pendingRes.data); } catch(e) {} }
      const idx = pending.findIndex(h => String(h.id) === String(body.id));
      if (idx === -1) {
        return jsonResponse({ error: "Pending homestay not found" }, 404, request);
      }
      const homestay = pending[idx];

      await purgeSensitiveImages(homestay, env, `rejectHomestay:${homestay.id}`);

      pending.splice(idx, 1);
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_pending", JSON.stringify(pending))
        .run();

      await invalidateOwnerSessions(db, homestay.id);

      await logAction({
        db,
        action: 'homestay_rejected',
        admin: 'admin',
        details: `Rejected homestay "${homestay.name}" (ID: ${homestay.id})${reason ? ' — reason: ' + reason : ''}`,
        ip: clientIP,
        userId: homestay.ownerEmail,
        homestayId: homestay.id
      });

      let emailResult = { sent: false };
      if (homestay.ownerEmail) {
        const html = rejectedEmailHtml({
          ownerName: homestay.ownerName || homestay.icName,
          homestayName: homestay.name,
          reason, env
        });
        emailResult = await sendStatusEmail({
          to: homestay.ownerEmail,
          subject: `Update on your listing "${homestay.name}" — Kundasang Homestay`,
          html, env,
          logContext: `rejectHomestay:${homestay.id}`
        });
      }

      return jsonResponse({
        success: true,
        emailSent: emailResult.sent === true,
        emailError: emailResult.sent === true ? undefined : emailResult.error
      }, 200, request);
    }

    // ---- Admin removeApprovedHomestay ----
    if (action === "removeApprovedHomestay" && body.id) {
      try {
        const isDemo = body.isDemo === true;

        const approvedRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
        let approved = [];
        if (approvedRes && approvedRes.data) {
          try { approved = JSON.parse(approvedRes.data); } catch(e) {
            return jsonResponse({ error: "Corrupt approved data" }, 500, request);
          }
        }

        const idx = approved.findIndex(h => String(h.id) === String(body.id));
        if (idx === -1) {
          return jsonResponse({ error: "Approved homestay not found" }, 404, request);
        }

        const removed = approved[idx];

        await purgeSensitiveImages(removed, env, `removeApprovedHomestay:${removed.id}`);

        approved.splice(idx, 1);

        if (isDemo) {
          const demoRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_deleted_demo").first();
          let deletedDemo = [];
          if (demoRes && demoRes.data) {
            try { deletedDemo = JSON.parse(demoRes.data); } catch(e) {}
          }
          if (!Array.isArray(deletedDemo)) deletedDemo = [];
          if (!deletedDemo.includes(String(body.id))) {
            deletedDemo.push(String(body.id));
          }
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_deleted_demo", JSON.stringify(deletedDemo))
            .run();
        }

        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_approved", JSON.stringify(approved))
          .run();

        await invalidateOwnerSessions(db, removed.id);

        await logAction({
          db,
          action: 'homestay_removed',
          admin: 'admin',
          details: `Removed homestay "${removed.name}" (ID: ${removed.id}) from approved`,
          ip: clientIP,
          userId: removed.ownerEmail,
          homestayId: removed.id
        });

        let emailResult = { sent: false };
        if (removed.ownerEmail) {
          const html = removedEmailHtml({
            ownerName: removed.ownerName || removed.icName,
            homestayName: removed.name,
            env
          });
          emailResult = await sendStatusEmail({
            to: removed.ownerEmail,
            subject: `⚠️ Your listing "${removed.name}" has been removed — Kundasang Homestay`,
            html, env,
            logContext: `removeApprovedHomestay:${removed.id}`
          });
        }

        return jsonResponse({
          success: true,
          removed: removed,
          emailSent: emailResult.sent === true,
          emailError: emailResult.sent === true ? undefined : emailResult.error
        }, 200, request);
      } catch (removeErr) {
        console.error("Remove homestay error:", removeErr.message);
        return jsonResponse({ error: "Remove failed. Please try again later." }, 500, request);
      }
    }

    // ---- Admin deleteGuest ----
    if (action === "deleteGuest") {
      const guestId = body.guestId ? String(body.guestId) : '';
      const email = body.email ? String(body.email).toLowerCase().trim() : '';

      if (!guestId && !email) {
        return jsonResponse({ error: 'Guest ID or email is required' }, 400, request);
      }

      const guestRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
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

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_guests", JSON.stringify(remainingGuests)).run();

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

    // ---- Admin deleteOwner ----
    if (action === "deleteOwner") {
      const ownerId = body.ownerId ? String(body.ownerId) : '';
      const email = body.email ? String(body.email).toLowerCase().trim() : '';
      const whatsapp = body.whatsapp ? String(body.whatsapp).replace(/[^0-9]/g, '') : '';

      if (!ownerId && !email && !whatsapp) {
        return jsonResponse({ error: 'Owner ID, email, or WhatsApp is required' }, 400, request);
      }

      const ownerRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_owners").first();
      let owners = [];
      if (ownerRes?.data) { try { owners = JSON.parse(ownerRes.data); } catch (_) {} }

      const deleted = owners.find(o =>
        (ownerId && String(o.id) === ownerId) ||
        (email && String(o.ownerEmail || '').toLowerCase().trim() === email) ||
        (whatsapp && String(o.whatsapp || '').replace(/[^0-9]/g, '') === whatsapp)
      );

      if (!deleted) {
        return jsonResponse({ error: 'Owner not found' }, 404, request);
      }

      const deletedId = String(deleted.id || '');
      const deletedEmail = String(deleted.ownerEmail || '').toLowerCase().trim();
      const deletedWa = String(deleted.whatsapp || '').replace(/[^0-9]/g, '');

      const sensitiveOwned = [];
      for (const key of ['kd_pending', 'kd_approved', 'kd_homestays']) {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind(key).first();
        if (!r?.data) continue;
        try {
          const arr = JSON.parse(r.data);
          arr.forEach(h => {
            if (String(h.whatsapp || '').replace(/[^0-9]/g, '') === deletedWa) {
              if (h.icImage) sensitiveOwned.push(h.icImage);
              if (h.bankQRImage) sensitiveOwned.push(h.bankQRImage);
              if (h.pbtLicense) sensitiveOwned.push(h.pbtLicense);
            }
          });
        } catch (_) {}
      }
      if (sensitiveOwned.length > 0) {
        const result = await deleteCloudinaryImages(sensitiveOwned, env);
        console.log(`[deleteOwner:${deletedId}] Purged ${result.deleted.length}/${sensitiveOwned.length} sensitive images`);
      }

      const remainingOwners = owners.filter(o => {
        const sameId = deletedId && String(o.id || '') === deletedId;
        const sameEmail = deletedEmail && String(o.ownerEmail || '').toLowerCase().trim() === deletedEmail;
        const sameWa = deletedWa && String(o.whatsapp || '').replace(/[^0-9]/g, '') === deletedWa;
        return !sameId && !sameEmail && !sameWa;
      });

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_owners", JSON.stringify(remainingOwners)).run();

      const removedHomes = { pending: 0, approved: 0, mirror: 0 };
      for (const key of ['kd_pending', 'kd_approved', 'kd_homestays']) {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind(key).first();
        if (!r?.data) continue;
        let arr = [];
        try { arr = JSON.parse(r.data); } catch (_) { continue; }
        const before = arr.length;
        const filtered = arr.filter(h =>
          String(h.whatsapp || '').replace(/[^0-9]/g, '') !== deletedWa
        );
        const removedCount = before - filtered.length;
        if (key === 'kd_pending') removedHomes.pending = removedCount;
        else if (key === 'kd_approved') removedHomes.approved = removedCount;
        else removedHomes.mirror = removedCount;
        if (filtered.length !== before) {
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind(key, JSON.stringify(filtered)).run();
        }
      }

      await logAction({
        db,
        action: 'owner_deleted',
        admin: 'admin',
        details: `Deleted owner ${deletedEmail || deletedId} (WhatsApp ${deletedWa}); removed ${removedHomes.pending} pending, ${removedHomes.approved} approved`,
        ip: clientIP,
        userId: deletedId
      });

      return jsonResponse({
        success: true,
        deleted: { id: deletedId, email: deletedEmail, whatsapp: deletedWa },
        removedHomes
      }, 200, request);
    }

    // ---- Admin updateHomestays ----
    if (action === "updateHomestays") {
      const { approved, demoOverrides, demoBlocked, deletedDemo } = body;

      if (!Array.isArray(approved)) {
        return jsonResponse({ error: 'Invalid approved data' }, 400, request);
      }

      const stmts = [];
      stmts.push(db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_approved", JSON.stringify(approved)));

      if (demoOverrides !== undefined) {
        stmts.push(db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_demo_overrides", JSON.stringify(demoOverrides)));
      }
      if (demoBlocked !== undefined) {
        stmts.push(db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_demo_blocked", JSON.stringify(demoBlocked)));
      }
      if (deletedDemo !== undefined) {
        stmts.push(db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_deleted_demo", JSON.stringify(deletedDemo)));
      }

      await db.batch(stmts);

      await logAction({
        db,
        action: 'homestays_updated',
        admin: 'admin',
        details: `Updated ${approved.length} approved homestays`,
        ip: clientIP,
        userId: 'admin'
      });

      return jsonResponse({ success: true, approved }, 200, request);
    }

    return jsonResponse({ success: true, message: "Synced" }, 200, request);

  } catch (err) {
    console.error('Bookings POST admin action error:', err.message);
    return jsonResponse({ error: 'An internal error occurred. Please try again later.' }, 500, request);
  }
}

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

  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
  let bookings = [];
  try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
  const idx = bookings.findIndex(b => String(b.id) === String(id));
  if (idx === -1) {
    return jsonResponse({ error: 'Booking not found' }, 404, request);
  }
  const deleted = bookings[idx];
  bookings.splice(idx, 1);
  await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
    .bind('kd_bookings', JSON.stringify(bookings)).run();

  await logAction({
    db,
    action: 'booking_deleted_admin',
    admin: 'admin',
    details: `Deleted booking ${id} (${deleted.homestay})`,
    ip: getClientIP(request),
    userId: deleted.guestId,
    homestayId: deleted.homestayId
  });

  return jsonResponse({ success: true, deleted: deleted }, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
