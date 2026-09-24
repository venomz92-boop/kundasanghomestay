// /api/delete-account.js
//
// [REVISION — 24 Sept 2026 — lock correctness]
// - Guest and owner deletion now perform their read -> decide -> write
//   under the shared 'bookings-global' lock. Previously both flows read
//   kd_bookings unlocked, then wrote it back with db.batch(), while every
//   other writer (bookings.js, chip-create.js, chip-webhook.js,
//   verify-payment.js, payout.js, ...) held the lock. An unlocked write
//   racing a locked one could revert it — e.g. a booking created or
//   finalised between this file's read and its write would be lost when
//   the stale snapshot was written back.
// - The password check stays OUTSIDE the lock: PBKDF2 is intentionally
//   slow, and holding a global lock across it would serialise every
//   deletion behind every login. The record is re-read inside the lock and
//   re-checked before anything is written.
// - Cloudinary image destruction and the confirmation email also stay
//   outside the lock (slow network I/O).
// - The blocking check (active bookings / in-flight payouts) now runs
//   inside the lock, so a booking can no longer be created in the gap
//   between the check and the write and be silently orphaned.
//
// [REVISION — 22 Sept 2026 — Phase 3]
// - validateCSRFToken now receives the caller's session version.
//   Guest uses session.sessionVersion; owner uses session.ownerSessionVersion.
//   Without this, every delete-account attempt returned 403 after the
//   session-bound CSRF change shipped.
// - Success responses are now Cache-Control: no-store.
// - Error log no longer includes the stack trace.
//
// NOT changed (intentional):
// - Bookings for the deleted account are already anonymised in place
//   (name/email/phone blanked, guestId replaced with DELETED-<ts>).
//   This file satisfies PDPA right-to-erasure for the account itself;
//   the admin deleteGuest / deleteOwner actions in bookings.js are
//   separate and still leave PII in bookings (Phase 4 policy item).
// - Guest deletion clears guest_token only (not owner_token/admin_token).
//   Owner deletion clears owner_token only. One-browser-one-identity
//   does not apply to self-delete; we don't want to log them out of an
//   unrelated identity.
import {
  corsHeaders,
  getClientIP,
  enforceHttps,
  getGuestSession,
  getOwnerSession,
  verifyPassword,
  getCSRFToken,
  validateCSRFToken,
  jsonResponse,
  parseJSONSafely,
  logAction,
  clearCookieHeader,
  sha256,
  withLock
} from './_utils.js';

// Same key every other writer of kd_bookings uses. Must stay in sync with
// BOOKINGS_LOCK in bookings.js, payout.js, chip-create.js, etc. — a
// different key would not exclude them, which is the bug this file used to
// have by simply not locking at all.
const BOOKINGS_LOCK = 'bookings-global';

function lockBusyResponse(request) {
  return jsonResponse({
    error: 'Another operation is in progress. Please try again in a moment.',
    code: 'LOCK_BUSY'
  }, 429, request);
}

// ---------- Cloudinary destroy (self-contained) ----------

async function destroyCloudinaryImage(publicId, env) {
  if (!publicId || typeof publicId !== 'string') return { skipped: true };
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return { error: 'Cloudinary credentials missing' };

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
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) return { error: `Cloudinary HTTP ${res.status}` };
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

function collectAllImagePublicIds(h) {
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

// ---------- Deletion confirmation email ----------

async function sendDeletionConfirmation(email, name, userType, env) {
  if (!email) return false;
  const safeName = String(name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const isOwner = userType === 'owner';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#0F382E;">Hello ${safeName},</h2>
      <p>Your Kundasang Homestay ${isOwner ? 'host' : 'guest'} account has been permanently deleted, as you requested.</p>

      <div style="background:#f0fdf4;padding:16px;border-radius:8px;margin:20px 0;font-size:14px;">
        <p style="margin:0 0 8px 0;"><strong>What was removed:</strong></p>
        <ul style="margin:0;padding-left:20px;">
          <li>Your account credentials and personal details</li>
          <li>Your saved preferences and session data</li>
          ${isOwner ? '<li>Your homestay listings and uploaded photos</li>' : ''}
        </ul>
      </div>

      <div style="background:#fffbeb;padding:16px;border-radius:8px;margin:20px 0;font-size:14px;">
        <p style="margin:0 0 8px 0;"><strong>What is retained:</strong></p>
        <p style="margin:0;">Past booking records are kept for accounting and legal compliance, but your name, email, and phone number have been removed from them. You can no longer be identified from those records.</p>
      </div>

      <p>If you did not request this deletion, please contact us immediately at <a href="mailto:support@kundasanghomestay.my">support@kundasanghomestay.my</a>.</p>
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
          to: email,
          subject: 'Your account has been deleted — Kundasang Homestay',
          html
        })
      });
      return r.ok;
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Your account has been deleted — Kundasang Homestay',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return r.ok;
    }
  } catch (e) {
    console.error('Deletion email error:', e.message);
  }
  return false;
}

// ---------- Handler ----------

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);

    const body = await parseJSONSafely(request);
    const userType = String(body.userType || '').toLowerCase().trim();
    const password = String(body.password || '');
    const confirmPhrase = String(body.confirmPhrase || '').trim();

    if (!['guest', 'owner'].includes(userType)) {
      return jsonResponse({ error: 'Invalid request' }, 400, request);
    }
    if (!password || password.length < 1) {
      return jsonResponse({ error: 'Password required to confirm account deletion' }, 400, request);
    }
    if (confirmPhrase !== 'DELETE') {
      return jsonResponse({ error: 'Type DELETE (all caps) to confirm' }, 400, request);
    }

    // ---- Auth ----
    let session;
    let sessionUserId;
    let sessionVersion = 0;
    if (userType === 'guest') {
      session = await getGuestSession(request, env);
      if (!session || session.type !== 'guest') {
        return jsonResponse({ error: 'Authentication required' }, 401, request);
      }
      sessionUserId = session.userId;
      sessionVersion = Number(session.sessionVersion ?? 0);
    } else {
      session = await getOwnerSession(request, env);
      if (!session || session.type !== 'owner') {
        return jsonResponse({ error: 'Authentication required' }, 401, request);
      }
      sessionUserId = session.ownerId;
      sessionVersion = Number(session.ownerSessionVersion ?? 0);
    }

    // ---- CSRF (session-version bound) ----
    const csrf = getCSRFToken(request);
    if (!csrf || !(await validateCSRFToken(csrf, sessionUserId, env, sessionVersion))) {
      return jsonResponse({ error: 'Invalid security token' }, 403, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ============================================================
    // GUEST FLOW
    // ============================================================
    if (userType === 'guest') {
      // ---- Password check first, OUTSIDE the lock ----
      // PBKDF2 is intentionally slow. Holding the global bookings lock
      // across it would stall every booking/payment operation behind an
      // arbitrary number of failed password attempts.
      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
      let guests = [];
      try { if (r?.data) guests = JSON.parse(r.data); } catch (_) {}
      const userRecord = guests.find(g => String(g.id) === String(session.userId));
      if (!userRecord) return jsonResponse({ error: 'Account not found' }, 404, request);

      const verified = await verifyPassword(password, userRecord, env);
      if (!verified.ok) {
        await logAction({
          db,
          action: 'delete_account_failed_password',
          admin: 'guest',
          details: `Guest ${userRecord.id} failed password check on delete-account`,
          ip: clientIP,
          userId: userRecord.id
        });
        return jsonResponse({ error: 'Incorrect password' }, 401, request);
      }

      // ---- Read -> decide -> write, all under the shared lock ----
      let outcome;
      try {
        outcome = await withLock(db, BOOKINGS_LOCK, async (db) => {
          // Re-read inside the lock: the snapshot used for the password
          // check may already be stale.
          const gr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests').first();
          let curGuests = [];
          try { if (gr?.data) curGuests = JSON.parse(gr.data); } catch (_) {}
          const cur = curGuests.find(g => String(g.id) === String(session.userId));
          if (!cur) return { status: 404, body: { error: 'Account not found' } };

          const brr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
          let bookings = [];
          try { if (brr?.data) bookings = JSON.parse(brr.data); } catch (_) {}

          const upcomingPaid = bookings.filter(b =>
            String(b.guestId) === String(session.userId) &&
            String(b.status || '') === 'Paid - Awaiting Check-in'
          );
          if (upcomingPaid.length > 0) {
            return {
              status: 409,
              body: {
                error: `You have ${upcomingPaid.length} paid booking(s) coming up. Please complete your stay(s) or cancel them before deleting your account.`,
                code: 'ACTIVE_BOOKINGS'
              }
            };
          }

          const remainingGuests = curGuests.filter(g => String(g.id) !== String(session.userId));

          const anonymizedBookings = bookings.map(b => {
            if (String(b.guestId) !== String(session.userId)) return b;
            return {
              ...b,
              guestName: 'Deleted User',
              guestEmail: '',
              guestPhone: '',
              guestId: `DELETED-${Date.now()}`,
              deleted_at: new Date().toISOString()
            };
          });

          await db.batch([
            db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_guests', JSON.stringify(remainingGuests)),
            db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_bookings', JSON.stringify(anonymizedBookings))
          ]);

          return { status: 200, record: cur };
        }, 60000);
      } catch (lockErr) {
        if (lockErr.message && lockErr.message.includes('in progress')) {
          return lockBusyResponse(request);
        }
        throw lockErr;
      }

      if (outcome.status !== 200) {
        return jsonResponse(outcome.body, outcome.status, request);
      }

      await logAction({
        db,
        action: 'guest_account_deleted',
        admin: 'guest',
        details: `Guest self-deleted: ${outcome.record.id} (${outcome.record.email})`,
        ip: clientIP,
        userId: outcome.record.id
      });

      sendDeletionConfirmation(outcome.record.email, outcome.record.name, 'guest', env).catch(() => {});

      return new Response(JSON.stringify({
        success: true,
        message: 'Your account has been deleted. A confirmation email has been sent.'
      }), {
        status: 200,
        headers: {
          ...corsHeaders(request),
          'Cache-Control': 'no-store',
          'Set-Cookie': clearCookieHeader('guest_token')
        }
      });
    }

    // ============================================================
    // OWNER FLOW
    // ============================================================
    // Resolve the owner record for the password check (outside the lock).
    const ownersRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_owners').first();
    let owners = [];
    try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch (_) {}

    const cleanOwnerKey = String(session.ownerId || '').replace(/[^0-9]/g, '');
    const userRecord = owners.find(o => String(o.id) === String(session.ownerId))
      || owners.find(o => String(o.whatsapp || '').replace(/[^0-9]/g, '') === cleanOwnerKey);

    if (!userRecord) {
      return jsonResponse({
        error: 'Owner account not found. If you registered before accounts were supported, please contact support@kundasanghomestay.my.'
      }, 404, request);
    }

    const verified = await verifyPassword(password, {
      ownerPasswordHash: userRecord.ownerPasswordHash,
      ownerSalt: userRecord.ownerSalt,
      ownerPasswordAlgorithm: userRecord.ownerPasswordAlgorithm
    }, env);

    if (!verified.ok) {
      await logAction({
        db,
        action: 'delete_account_failed_password',
        admin: 'owner',
        details: `Owner ${userRecord.id} failed password check on delete-account`,
        ip: clientIP,
        userId: userRecord.id
      });
      return jsonResponse({ error: 'Incorrect password' }, 401, request);
    }

    const cleanWa = String(userRecord.whatsapp || '').replace(/[^0-9]/g, '');

    // ---- Read -> decide -> write, all under the shared lock ----
    let outcome;
    try {
      outcome = await withLock(db, BOOKINGS_LOCK, async (db) => {
        const approvedRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved').first();
        const pendingRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_pending').first();
        const homeRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_homestays').first();
        const brr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();

        let approved = []; try { if (approvedRes?.data) approved = JSON.parse(approvedRes.data); } catch (_) {}
        let pending = []; try { if (pendingRes?.data) pending = JSON.parse(pendingRes.data); } catch (_) {}
        let allHomes = []; try { if (homeRes?.data) allHomes = JSON.parse(homeRes.data); } catch (_) {}
        let bookings = []; try { if (brr?.data) bookings = JSON.parse(brr.data); } catch (_) {}

        // Re-resolve the owner inside the lock (the outer read may be stale).
        const oRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_owners').first();
        let curOwners = [];
        try { if (oRes?.data) curOwners = JSON.parse(oRes.data); } catch (_) {}
        const curOwner = curOwners.find(o => String(o.id) === String(userRecord.id));
        if (!curOwner) {
          return { status: 404, body: { error: 'Account not found' } };
        }

        const myHomestayIds = new Set();
        [...approved, ...pending].forEach(h => {
          const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
          if (hWa && hWa === cleanWa) myHomestayIds.add(String(h.id));
        });

        const blockingBookings = bookings.filter(b => {
          if (!myHomestayIds.has(String(b.homestayId))) return false;
          const s = String(b.status || '');
          if (s === 'Paid - Awaiting Check-in') return true;
          if (b.payoutAttemptedAt && !b.payoutSuccessDate && !b.payoutUnknown) return true;
          return false;
        });

        if (blockingBookings.length > 0) {
          return {
            status: 409,
            body: {
              error: `You have ${blockingBookings.length} active booking(s) or in-flight payouts on your properties. Please resolve those first (complete the check-in or wait for the payout to finish), then delete your account.`,
              code: 'ACTIVE_BOOKINGS'
            }
          };
        }

        const allPublicIds = new Set();
        [...approved, ...pending].forEach(h => {
          const hWa = String(h.whatsapp || '').replace(/[^0-9]/g, '');
          if (hWa === cleanWa) {
            collectAllImagePublicIds(h).forEach(pid => allPublicIds.add(pid));
          }
        });

        const remainingOwners = curOwners.filter(o => String(o.id) !== String(curOwner.id));
        const remainingApproved = approved.filter(h => String(h.whatsapp || '').replace(/[^0-9]/g, '') !== cleanWa);
        const remainingPending = pending.filter(h => String(h.whatsapp || '').replace(/[^0-9]/g, '') !== cleanWa);
        const remainingHomes = allHomes.filter(h => !myHomestayIds.has(String(h.id)));

        const userEmailLower = String(curOwner.ownerEmail || '').toLowerCase().trim();
        const anonymizedBookings = bookings.map(b => {
          const bEmail = String(b.guestEmail || '').toLowerCase().trim();
          if (bEmail && userEmailLower && bEmail === userEmailLower) {
            return {
              ...b,
              guestName: 'Deleted User',
              guestEmail: '',
              guestPhone: '',
              guestId: `DELETED-${Date.now()}`,
              deleted_at: new Date().toISOString()
            };
          }
          return b;
        });

        await db.batch([
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_owners', JSON.stringify(remainingOwners)),
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_approved', JSON.stringify(remainingApproved)),
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_pending', JSON.stringify(remainingPending)),
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_homestays', JSON.stringify(remainingHomes)),
          db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(anonymizedBookings))
        ]);

        return {
          status: 200,
          record: curOwner,
          publicIds: [...allPublicIds],
          homestayCount: myHomestayIds.size
        };
      }, 60000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        return lockBusyResponse(request);
      }
      throw lockErr;
    }

    if (outcome.status !== 200) {
      return jsonResponse(outcome.body, outcome.status, request);
    }

    // ---- Slow network work happens AFTER the lock is released ----
    let destroyed = 0;
    let destroyFailed = 0;
    for (const pid of outcome.publicIds) {
      const rr = await destroyCloudinaryImage(pid, env);
      if (rr.success) destroyed++;
      else destroyFailed++;
    }

    await logAction({
      db,
      action: 'owner_account_deleted',
      admin: 'owner',
      details: `Owner self-deleted: ${outcome.record.id} (${outcome.record.ownerEmail}); ${outcome.homestayCount} listing(s) removed; ${destroyed}/${outcome.publicIds.length} Cloudinary images destroyed; ${destroyFailed} failed`,
      ip: clientIP,
      userId: outcome.record.id
    });

    sendDeletionConfirmation(outcome.record.ownerEmail, outcome.record.ownerName, 'owner', env).catch(() => {});

    return new Response(JSON.stringify({
      success: true,
      message: 'Your host account and all its listings have been deleted. A confirmation email has been sent.'
    }), {
      status: 200,
      headers: {
        ...corsHeaders(request),
        'Cache-Control': 'no-store',
        'Set-Cookie': clearCookieHeader('owner_token')
      }
    });

  } catch (e) {
    console.error('Delete account error:', e.message);
    return jsonResponse({ error: 'Could not delete account. Please contact support@kundasanghomestay.my.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
