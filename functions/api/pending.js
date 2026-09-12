// /api/pending.js — Plain English: this is the "submit a new homestay
// listing" endpoint used by hosts. Before this change, ANYONE could submit
// a listing by typing any password — no account, no verification. That
// let fake listings into the review queue. Now we require either:
//   (a) an already-logged-in verified host, OR
//   (b) a host password that matches an existing verified host account.
// If neither applies, we return 401 telling the user to register and
// verify first. The admin force-sync path and the admin delete path are
// unchanged.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  hashPassword,
  verifyPassword,
  verifyAdminAuth,
  getOwnerSession,
  jsonResponse,
  checkRateLimit,
  recordRateLimit,
  parseJSONSafely
} from './_utils.js';

import {
  sanitizeString,
  isValidEmail,
  isValidPhone,
  isValidPrice,
  sanitizeDescription,
  validateBankCode
} from './_utils.js';

async function requireAdmin(request, env) {
  const ok = await verifyAdminAuth(request, env);
  if (!ok) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request);
  }
  return null;
}

async function read(db, key) {
  const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();
  try { return r?.data ? JSON.parse(r.data) : []; } catch (_) { return []; }
}

async function syncHomestayToHomestays(db, homestay) {
  let homestays = await read(db, 'kd_homestays');
  const idx = homestays.findIndex(h => String(h.id) === String(homestay.id));
  const now = new Date().toISOString();
  const entry = {
    id: homestay.id,
    name: homestay.name,
    location: homestay.location,
    description: homestay.description || '',
    ownerName: homestay.ownerName,
    ownerEmail: homestay.ownerEmail,
    whatsapp: homestay.whatsapp,
    ownerId: homestay.ownerId || null,
    ownerBank: homestay.ownerBank || '',
    ownerBankAccount: homestay.ownerBankAccount || '',
    bankCode: homestay.bankCode || '',
    bankHolder: homestay.bankHolder || '',
    bankQRImage: homestay.bankQRImage || '',
    images: homestay.images || [],
    rooms: homestay.rooms || [],
    ownerPrice: homestay.ownerPrice,
    guests: homestay.guests,
    bedrooms: homestay.bedrooms,
    blockedDates: homestay.blockedDates || [],
    approved: homestay.approved || false,
    verified: homestay.verified || false,
    rating: homestay.rating || 0,
    reviews: homestay.reviews || 0,
    createdAt: idx >= 0 ? homestays[idx].createdAt || homestay.createdAt || now : now,
    updatedAt: now
  };
  if (idx >= 0) {
    homestays[idx] = { ...homestays[idx], ...entry };
  } else {
    homestays.push(entry);
  }
  await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
    .bind('kd_homestays', JSON.stringify(homestays))
    .run();
  return homestays;
}

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  const err = await requireAdmin(request, env);
  if (err) return err;
  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
  await db.prepare('CREATE TABLE IF NOT EXISTS store(key TEXT PRIMARY KEY, data TEXT)').run();
  return jsonResponse(await read(db, 'kd_pending'), 200, request, { 'Cache-Control': 'no-store' });
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    let body;
    try {
      body = await parseJSONSafely(request);
    } catch (_) {
      return jsonResponse({ error: 'Invalid JSON or payload too large' }, 400, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store(key TEXT PRIMARY KEY, data TEXT)').run();

    // ============================================================
    // ADMIN UPDATE MODE — used by admin.html Force Sync
    // (unchanged)
    // ============================================================
    if (Object.prototype.hasOwnProperty.call(body, 'pending') && body.pending !== undefined) {
      const ok = await verifyAdminAuth(request, env);
      if (!ok) {
        return jsonResponse({ error: 'Unauthorized' }, 401, request);
      }
      if (!Array.isArray(body.pending)) {
        return jsonResponse({ error: 'Invalid pending payload' }, 400, request);
      }
      await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
        .bind('kd_pending', JSON.stringify(body.pending))
        .run();
      await logAction({
        db,
        action: 'pending_synced_admin',
        admin: 'admin',
        details: `Pending list force-synced (${body.pending.length} items)`,
        ip: getClientIP(request)
      });
      return jsonResponse({ success: true, pending: body.pending }, 200, request);
    }

    // ============================================================
    // PUBLIC SUBMIT MODE — M4: now requires a verified owner account
    // ============================================================
    const h = body.homestay || body.listing;
    if (!h) {
      return jsonResponse({ error: 'Homestay data is required' }, 400, request);
    }

    const clientIP = getClientIP(request);

    // Load kd_owners once so both auth paths can use it.
    const ownersRes = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_owners').first();
    let owners = [];
    try { if (ownersRes?.data) owners = JSON.parse(ownersRes.data); } catch(_) {}

    let authenticatedOwnerAccount = null;

    // ---- Path A: authenticated owner session ----
    const ownerSession = await getOwnerSession(request, env);
    if (ownerSession && ownerSession.type === 'owner') {
      const cleanWa = String(ownerSession.whatsapp || ownerSession.ownerId || '').replace(/[^0-9]/g, '');
      if (cleanWa) {
        const acc = owners.find(o => String(o.whatsapp || '').replace(/[^0-9]/g, '') === cleanWa);
        if (acc && acc.verified === true) {
          authenticatedOwnerAccount = acc;
        }
      }
    }

    // ---- Path B: legacy ownerPassword against an existing verified account ----
    const ownerPassword = String(body.ownerPassword || '');
    const ownerWhatsappInput = String(h.whatsapp || '').replace(/[^0-9]/g, '');

    if (!authenticatedOwnerAccount) {
      if (!ownerPassword || !ownerWhatsappInput) {
        return jsonResponse({
          error: 'You must register and verify your host account before submitting a listing.',
          code: 'OWNER_ACCOUNT_REQUIRED',
          hint: 'Please create a host account first, verify your email, then log in and submit from the Host Panel.'
        }, 401, request);
      }

      const acc = owners.find(o =>
        String(o.whatsapp || '').replace(/[^0-9]/g, '') === ownerWhatsappInput
      );

      if (!acc || acc.verified !== true) {
        return jsonResponse({
          error: 'You must register and verify your host account before submitting a listing.',
          code: 'OWNER_ACCOUNT_REQUIRED',
          hint: 'No verified host account was found for that phone number. Please register first.'
        }, 401, request);
      }

      // Constant-ish verification: PBKDF2 against the stored hash.
      const verified = await verifyPassword(ownerPassword, {
        ownerPasswordHash: acc.ownerPasswordHash,
        ownerSalt: acc.ownerSalt,
        ownerPasswordAlgorithm: acc.ownerPasswordAlgorithm
      }, env);

      if (!verified.ok) {
        await recordRateLimit(db, clientIP, 'pending_submit');
        return jsonResponse({
          error: 'Invalid host password.',
          code: 'INVALID_OWNER_PASSWORD'
        }, 401, request);
      }

      authenticatedOwnerAccount = acc;
    }

    // From here on, we have a verified owner account. Trusted identity:
    const ownerId = authenticatedOwnerAccount.id;
    const ownerName = authenticatedOwnerAccount.ownerName;
    const ownerEmail = String(authenticatedOwnerAccount.ownerEmail || '').toLowerCase().trim();
    const ownerWhatsapp = String(authenticatedOwnerAccount.whatsapp || '').replace(/[^0-9]/g, '');

    // M4: dynamic required fields. Owner identity comes from the account,
    // so the client doesn't need to re-supply it.
    const required = ['name', 'location', 'ownerPrice', 'ownerBankAccount', 'bankHolder'];
    for (const key of required) {
      if (h[key] === undefined || h[key] === null || String(h[key]).trim() === '') {
        return jsonResponse({ error: `Missing required field: ${key}` }, 400, request);
      }
    }

    const name = sanitizeString(h.name, 100);
    const location = sanitizeString(h.location, 50);
    const finalOwnerName = ownerName;
    const finalOwnerEmail = ownerEmail;
    const finalWhatsapp = ownerWhatsapp;
    const ownerBankAccount = String(h.ownerBankAccount || '').replace(/[^0-9]/g, '');
    const bankHolder = sanitizeString(h.bankHolder, 100);
    const description = sanitizeDescription(h.description || '');
    const icName = sanitizeString(h.icName || '', 100);
    const icNumber = String(h.icNumber || '').replace(/[^0-9-]/g, '').slice(0, 20);
    const bankName = sanitizeString(h.ownerBank || '', 50);
    const bankCode = validateBankCode(h.bankCode || '');
    const price = Number(h.ownerPrice);
    const guests = Math.max(1, Math.min(20, Number(h.guests) || 1));
    const bedrooms = Math.max(1, Math.min(10, Number(h.bedrooms) || 1));

    if (!isValidEmail(finalOwnerEmail)) {
      return jsonResponse({ error: 'Invalid email address on owner account' }, 400, request);
    }
    if (!isValidPhone(finalWhatsapp)) {
      return jsonResponse({ error: 'Invalid WhatsApp number on owner account' }, 400, request);
    }
    if (!isValidPrice(price)) {
      return jsonResponse({ error: 'Invalid nightly price (must be > RM0 and < RM100,000)' }, 400, request);
    }
    if (ownerBankAccount.length < 8) {
      return jsonResponse({ error: 'Bank account number must be at least 8 digits' }, 400, request);
    }
    if (!icName || icName.length < 2) {
      return jsonResponse({ error: 'IC name is required' }, 400, request);
    }

    const rateOk = await checkRateLimit(db, clientIP, 'pending_submit', 3, 60 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many submissions. Please wait an hour.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, 'pending_submit');

    const pending = await read(db, 'kd_pending');
    const approved = await read(db, 'kd_approved');

    // Detect same email OR same name+location to catch obvious duplicates
    const existingPending = pending.find(x =>
      String(x.ownerEmail || '').toLowerCase() === finalOwnerEmail ||
      (String(x.name || '').toLowerCase() === name.toLowerCase() &&
       String(x.location || '').toLowerCase() === location.toLowerCase())
    );
    const existingApproved = approved.find(x =>
      String(x.ownerEmail || '').toLowerCase() === finalOwnerEmail
    );

    if (existingApproved) {
      return jsonResponse({
        error: 'You already have an approved listing with this email. Log into your Host Panel to manage it, or use a different email to add another property.',
        code: 'ALREADY_APPROVED',
        hint: 'Use the "Host Login" button on the homepage to access your dashboard.'
      }, 409, request);
    }

    if (existingPending) {
      return jsonResponse({
        error: 'You already have a listing under review with this email. Please wait for approval, or log into your Host Panel if you have already received your welcome email.',
        code: 'ALREADY_PENDING',
        hint: 'Approvals usually take up to 24 hours. Check your inbox for the verification email.'
      }, 409, request);
    }

    // Reuse the verified owner account's stored password hash.
    const passwordFields = {
      ownerPasswordHash: authenticatedOwnerAccount.ownerPasswordHash,
      ownerSalt: authenticatedOwnerAccount.ownerSalt,
      ownerPasswordAlgorithm: authenticatedOwnerAccount.ownerPasswordAlgorithm,
      ownerPasswordVersion: authenticatedOwnerAccount.ownerPasswordVersion || 1
    };

    const clean = {
      ...h,
      id: h.id || Date.now(),
      name,
      location,
      description,
      ownerName: finalOwnerName,
      ownerEmail: finalOwnerEmail,
      whatsapp: finalWhatsapp,
      ownerId,
      ownerBank: bankName,
      ownerBankAccount,
      bankCode,
      bankHolder,
      ownerPrice: Math.round(price * 100) / 100,
      guests,
      bedrooms,
      icName,
      icNumber,
      images: Array.isArray(h.images) ? h.images.slice(0, 20) : [],
      rooms: Array.isArray(h.rooms) ? h.rooms.slice(0, 20) : [],
      blockedDates: Array.isArray(h.blockedDates)
        ? h.blockedDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 365)
        : [],
      approved: false,
      verified: false,
      ...passwordFields,
      createdAt: new Date().toISOString()
    };
    delete clean.password;
    delete clean.ownerPassword;

    pending.push(clean);
    await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
      .bind('kd_pending', JSON.stringify(pending))
      .run();
    await syncHomestayToHomestays(db, clean);

    await logAction({
      db,
      action: 'homestay_submitted',
      admin: 'owner',
      details: `Homestay ${clean.id} submitted by owner account ${ownerId}`,
      ip: clientIP,
      userId: clean.ownerEmail,
      homestayId: clean.id
    });

    return jsonResponse({
      success: true,
      homestay: {
        ...clean,
        ownerPasswordHash: undefined,
        ownerSalt: undefined,
        ownerPasswordAlgorithm: undefined
      }
    }, 201, request);

  } catch (e) {
    console.error('Pending registration error:', e.message);
    return jsonResponse({ error: 'Could not submit listing. Please try again later.' }, 500, request);
  }
}

export async function onRequestDelete({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  const err = await requireAdmin(request, env);
  if (err) return err;
  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return jsonResponse({ success: true }, 200, request);

  const pending = await read(db, 'kd_pending');
  const deleted = pending.find(h => String(h.id) === String(id));
  const next = pending.filter(h => String(h.id) !== String(id));
  await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
    .bind('kd_pending', JSON.stringify(next))
    .run();

  await logAction({
    db,
    action: 'homestay_pending_deleted',
    admin: 'admin',
    details: `Deleted pending homestay ${id}`,
    ip: getClientIP(request),
    userId: deleted?.ownerEmail,
    homestayId: id
  });
  return jsonResponse({ success: true, deleted: id }, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
