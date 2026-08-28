import { corsHeaders, getClientIP, logAction, enforceHttps, validateCSRFToken, getCSRFToken, getGuestSession, getAdminToken, jsonResponse, parseJSONSafely } from './_utils.js';

const MAX_NIGHTS = 60;

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

async function verifyAdmin(request, env) {
  const auth = await getAdminToken(request);
  if (!env.ADMIN_TOKEN) return jsonResponse({ error: "Server misconfigured" }, 500, request);
  if (auth !== env.ADMIN_TOKEN) return jsonResponse({ error: "Unauthorized" }, 401, request);
  return null;
}

async function requireGuest(request, env, body) {
  const session = await getGuestSession(request, env);
  if (!session || session.type !== 'guest') return { error: jsonResponse({ error: 'Auth required' }, 401, request) };
  const guestId = body?.booking?.guestId || body?.guestId;
  if (guestId && String(guestId) !== String(session.userId)) return { error: jsonResponse({ error: 'Identity mismatch' }, 403, request) };
  const csrf = getCSRFToken(request);
  if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) return { error: jsonResponse({ error: 'Invalid CSRF' }, 403, request) };
  return { session };
}

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB error' }, 500, request);

  try {
    const guestSession = await getGuestSession(request, env);
    const adminToken = await getAdminToken(request);
    const isAdmin = adminToken && adminToken === env.ADMIN_TOKEN;

    const keys = ['kd_bookings', 'kd_approved', 'kd_guests'];
    const stmts = keys.map(key => db.prepare('SELECT data FROM store WHERE key = ?').bind(key));
    const results = await db.batch(stmts);

    const dataMap = {};
    keys.forEach((key, index) => {
      const row = results[index]?.results?.[0];
      try { dataMap[key] = row?.data ? JSON.parse(row.data) : []; } catch (_) { dataMap[key] = []; }
    });

    if (isAdmin) {
      return jsonResponse({
        bookings: dataMap['kd_bookings'],
        approved: dataMap['kd_approved'],
        guests: dataMap['kd_guests'].map(({password, salt, ...safe}) => safe)
      }, 200, request);
    }

    if (guestSession) {
      const mine = dataMap['kd_bookings'].filter(b => String(b.guestId) === String(guestSession.userId));
      return jsonResponse({ bookings: mine }, 200, request);
    }

    // Public view: Availability aggregation
    const availability = {};
    dataMap['kd_approved'].forEach(h => {
      availability[String(h.id)] = dataMap['kd_bookings']
        .filter(b => String(b.homestayId) === String(h.id) && !/cancelled|failed|expired/i.test(b.status || ''))
        .flatMap(b => getDatesInRange(b.checkin, b.checkout));
    });

    return jsonResponse({ approved: dataMap['kd_approved'], availability }, 200, request, {
      'Cache-Control': 'public, max-age=60'
    });
  } catch (e) {
    return jsonResponse({ error: 'Load failed' }, 500, request);
  }
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  let body;
  try { body = await parseJSONSafely(request); } catch (e) { return jsonResponse({ error: 'Invalid payload' }, 400, request); }
  const action = body.action;
  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB error' }, 500, request);

  if (action === "createPublicBooking") {
    const auth = await requireGuest(request, env, body);
    if (auth.error) return auth.error;
    const incoming = body.booking;

    const [bRes, aRes, gRes] = await db.batch([
      db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings'),
      db.prepare('SELECT data FROM store WHERE key=?').bind('kd_approved'),
      db.prepare('SELECT data FROM store WHERE key=?').bind('kd_guests')
    ]);

    let bookings = JSON.parse(bRes.results[0]?.data || '[]');
    let approved = JSON.parse(aRes.results[0]?.data || '[]');
    let guests = JSON.parse(gRes.results[0]?.data || '[]');

    const guest = guests.find(g => String(g.id) === String(auth.session.userId));
    const homestay = approved.find(h => String(h.id) === String(incoming.homestayId));
    if (!guest || !homestay) return jsonResponse({ error: 'Not found' }, 404, request);

    const room = homestay.rooms?.find(r => r.id === incoming.roomId);
    const price = room ? parseFloat(room.price) : parseFloat(homestay.ownerPrice);
    if (!price || price <= 0) return jsonResponse({ error: 'Config error' }, 500, request);

    const ci = incoming.checkin, co = incoming.checkout;
    const d1 = new Date(ci+'T00:00:00'), d2 = new Date(co+'T00:00:00');
    if (d1 >= d2 || d1 < new Date().setHours(0,0,0,0)) return jsonResponse({ error: 'Invalid dates' }, 400, request);

    const nights = Math.round((d2-d1)/86400000);
    if (nights > MAX_NIGHTS) return jsonResponse({ error: 'Too long' }, 400, request);

    // Overlap Check
    const overlap = bookings.some(b => {
      const match = room ? String(b.roomId) === String(room.id) : String(b.homestayId) === String(homestay.id);
      return match && !/cancelled|failed|expired/i.test(b.status) && ci < b.checkout && co > b.checkin;
    });
    if (overlap) return jsonResponse({ error: 'Dates taken' }, 409, request);

    const base = Math.round(price * nights * 100) / 100;
    const fee = Math.round(base * 0.11 * 100) / 100;
    const total = Math.round((base + fee + 1.00) * 100) / 100;
    const bookingId = `KDH-${crypto.randomUUID().slice(0,8).toUpperCase()}`;

    const booking = {
      id: bookingId, homestay: homestay.name, homestayId: homestay.id,
      guestId: guest.id, guestName: guest.name, guestEmail: guest.email, guestPhone: guest.phone,
      checkin: ci, checkout: co, nights, base, fee, gatewayFee: 1.00, total,
      status: 'Pending Payment', date: new Date().toISOString(),
      checkinCode: String(Math.floor(100000 + Math.random() * 900000)),
      roomId: room?.id || null, roomName: room?.name || null
    };

    bookings.push(booking);
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)').bind('kd_bookings', JSON.stringify(bookings)).run();
    await logAction({db, action:'booking_created', userId:guest.id, homestayId:homestay.id, details: bookingId});
    
    return jsonResponse({ success: true, booking }, 200, request);
  }

  // Admin actions...
  const adminErr = await verifyAdmin(request, env);
  if (adminErr) return adminErr;

  if (action === "approveHomestay") {
    const pRow = await db.prepare('SELECT data FROM store WHERE key="kd_pending"').first();
    const aRow = await db.prepare('SELECT data FROM store WHERE key="kd_approved"').first();
    let pending = JSON.parse(pRow?.data || '[]');
    let approved = JSON.parse(aRow?.data || '[]');
    const idx = pending.findIndex(h => String(h.id) === String(body.id));
    if (idx === -1) return jsonResponse({error:'Not found'}, 404, request);
    
    const h = pending.splice(idx, 1)[0];
    h.approved = true; h.verified = true;
    approved.push(h);
    
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO store (key,data) VALUES (?,?)').bind('kd_pending', JSON.stringify(pending)),
      db.prepare('INSERT OR REPLACE INTO store (key,data) VALUES (?,?)').bind('kd_approved', JSON.stringify(approved))
    ]);
    return jsonResponse({success:true}, 200, request);
  }

  return jsonResponse({ error: 'Invalid action' }, 400, request);
}

export async function onRequestDelete({ request, env }) {
  const err = await verifyAdmin(request, env);
  if (err) return err;
  const id = new URL(request.url).searchParams.get('id');
  const db = env.DB;
  const row = await db.prepare('SELECT data FROM store WHERE key="kd_bookings"').first();
  let bookings = JSON.parse(row?.data || '[]');
  const next = bookings.filter(b => String(b.id) !== id);
  await db.prepare('INSERT OR REPLACE INTO store (key,data) VALUES (?,?)').bind('kd_bookings', JSON.stringify(next)).run();
  return jsonResponse({success:true}, 200, request);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
