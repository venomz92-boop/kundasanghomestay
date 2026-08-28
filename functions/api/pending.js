// /api/pending.js
import { corsHeaders, getClientIP, logAction, enforceHttps, hashPassword, getAdminToken, jsonResponse } from './_utils.js';

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

// ===== Helper to sync homestay to kd_homestays (for payouts) =====
async function syncHomestayToHomestays(db, homestay) {
  // Ensure the homestay has all required payout fields
  const now = new Date().toISOString();
  const homestays = await read(db, 'kd_homestays');
  const idx = homestays.findIndex(h => String(h.id) === String(homestay.id));
  
  const entry = {
    // Core fields
    id: homestay.id,
    name: homestay.name,
    location: homestay.location,
    description: homestay.description || '',
    ownerName: homestay.ownerName,
    ownerEmail: homestay.ownerEmail,
    whatsapp: homestay.whatsapp,
    // Payout fields (critical)
    ownerBank: homestay.ownerBank || '',
    ownerBankAccount: homestay.ownerBankAccount || '',
    bankCode: homestay.bankCode || '',
    bankHolder: homestay.bankHolder || '',
    bankQRImage: homestay.bankQRImage || '',
    // Other listing data
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
    // Timestamps
    updatedAt: now,
    createdAt: idx >= 0 ? homestays[idx].createdAt || homestay.createdAt || now : now,
  };

  if (idx >= 0) {
    homestays[idx] = { ...homestays[idx], ...entry };
  } else {
    homestays.push(entry);
  }

  await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
    .bind('kd_homestays', JSON.stringify(homestays))
    .run();
}

// ===== GET (admin only) =====
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

// ===== POST (public registration) =====
export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const body = await request.json();
    const h = body.homestay || body.listing;
    const ownerPassword = String(body.ownerPassword || '');
    
    // --- Validation ---
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
    const price = Number(h.ownerPrice);
    if (!Number.isFinite(price) || price <= 0 || price > 100000) {
      return jsonResponse({ error: 'Invalid nightly price' }, 400, request);
    }

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store(key TEXT PRIMARY KEY, data TEXT)').run();

    // --- Check duplicates in pending & approved ---
    const pending = await read(db, 'kd_pending');
    const approved = await read(db, 'kd_approved');
    const whatsapp = String(h.whatsapp).replace(/[^0-9]/g, '');
    const duplicate = [...pending, ...approved].some(x =>
      String(x.ownerEmail || '').toLowerCase() === String(h.ownerEmail).toLowerCase() &&
      String(x.name || '').toLowerCase() === String(h.name).toLowerCase()
    );
    if (duplicate) {
      return jsonResponse({ error: 'A listing with this owner email and property name already exists.' }, 409, request);
    }

    // --- Hash password ---
    const hashed = await hashPassword(ownerPassword, env);

    // --- Build clean homestay object ---
    const clean = {
      ...h,
      id: h.id || Date.now(),
      whatsapp,
      ownerPrice: Math.round(price * 100) / 100,
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

    // --- Save to pending ---
    pending.push(clean);
    await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
      .bind('kd_pending', JSON.stringify(pending))
      .run();

    // --- 🔥 NEW: Sync to kd_homestays (so payouts can find it) ---
    await syncHomestayToHomestays(db, clean);

    // --- Log action ---
    await logAction({
      db,
      action: 'homestay_submitted',
      admin: 'public',
      details: `Homestay ${clean.id} submitted and synced to homestays store`,
      ip: getClientIP(request),
      userId: clean.ownerEmail,
      homestayId: clean.id
    });

    // --- Return success ---
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
    return jsonResponse({ error: 'Could not submit listing' }, 500, request);
  }
}

// ===== DELETE (admin only) =====
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

  // Also remove from kd_homestays if desired? We'll keep it for record, but you can optionally remove.
  // We'll not remove from kd_homestays to avoid losing data if re-submitted.

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

// ===== OPTIONS =====
export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
