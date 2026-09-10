// /api/pending.js – With server‑side validation + admin update mode + rate limiting
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  hashPassword,
  getAdminToken,
  jsonResponse,
  checkRateLimit,
  recordRateLimit
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
  const token = await getAdminToken(request);
  if (!token || !env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
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
    const body = await request.json();

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store(key TEXT PRIMARY KEY, data TEXT)').run();

    // ============================================================
    // ADMIN UPDATE MODE — used by admin.html Force Sync
    // Accepts { pending: [...] } to overwrite kd_pending wholesale.
    // ============================================================
    if (Object.prototype.hasOwnProperty.call(body, 'pending') && body.pending !== undefined) {
      const adminToken = await getAdminToken(request);
      if (!adminToken || !env.ADMIN_TOKEN || adminToken !== env.ADMIN_TOKEN) {
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
    // PUBLIC SUBMIT MODE
    // ============================================================
    const h = body.homestay || body.listing;
    const ownerPassword = String(body.ownerPassword || '');

    if (!h || !ownerPassword) {
      return jsonResponse({ error: 'Homestay and ownerPassword are required' }, 400, request);
    }
    if (ownerPassword.length < 8) {
      return jsonResponse({ error: 'Owner password must be at least 8 characters' }, 400, request);
    }

    const required = ['name', 'location', 'ownerPrice', 'ownerName', 'whatsapp', 'ownerEmail', 'ownerBankAccount', 'bankHolder'];
    for (const key of required) {
      if (h[key] === undefined || h[key] === null || String(h[key]).trim() === '') {
        return jsonResponse({ error: `Missing required field: ${key}` }, 400, request);
      }
    }

    const name = sanitizeString(h.name, 100);
    const location = sanitizeString(h.location, 50);
    const ownerName = sanitizeString(h.ownerName, 100);
    const ownerEmail = String(h.ownerEmail || '').toLowerCase().trim();
    const whatsapp = String(h.whatsapp || '').replace(/[^0-9]/g, '');
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

    if (!isValidEmail(ownerEmail)) {
      return jsonResponse({ error: 'Invalid email address' }, 400, request);
    }
    if (!isValidPhone(whatsapp)) {
      return jsonResponse({ error: 'Invalid WhatsApp number' }, 400, request);
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

    const clientIP = getClientIP(request);
    const rateOk = await checkRateLimit(db, clientIP, 'pending_submit', 3, 60 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many submissions. Please wait an hour.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, 'pending_submit');

    const pending = await read(db, 'kd_pending');
    const approved = await read(db, 'kd_approved');
    const duplicate = [...pending, ...approved].some(x =>
      String(x.ownerEmail || '').toLowerCase() === ownerEmail &&
      String(x.name || '').toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      return jsonResponse({ error: 'Unable to submit listing. Please check your details or contact support.' }, 400, request);
    }

    const hashed = await hashPassword(ownerPassword, env);

    const clean = {
      ...h,
      id: h.id || Date.now(),
      name,
      location,
      description,
      ownerName,
      ownerEmail,
      whatsapp,
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
      blockedDates: Array.isArray(h.blockedDates) ? h.blockedDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 365) : [],
      approved: false,
      verified: false,
      ownerPasswordHash: hashed.hash,
      ownerSalt: hashed.salt,
      ownerPasswordAlgorithm: hashed.algorithm,
      ownerPasswordVersion: 1,
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
      admin: 'public',
      details: `Homestay ${clean.id} submitted and synced`,
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
