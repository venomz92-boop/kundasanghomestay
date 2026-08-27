// /api/bookings.js - with checkinCode, email sending, per‑room availability, optimistic locking, and room images
// PATCHED: improved retry logic with delays and proper error returns
import { corsHeaders, getClientIP, logAction, enforceHttps, validateCSRFToken, getCSRFToken, getGuestSession, getAdminToken, jsonResponse, parseJSONSafely } from './_utils.js';

const MAX_NIGHTS = 60;
const DEFAULT_PAGE_SIZE = 50;

// ===== Helper: getDatesInRange =====
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

// ===== verifyAdmin =====
async function verifyAdmin(request, env) {
  const auth = await getAdminToken(request);
  if (!env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers: corsHeaders(request) });
  if (auth !== env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders(request) });
  return null;
}

// ===== requireGuest =====
async function requireGuest(request, env, body) {
  const session = await getGuestSession(request, env);
  if (!session || session.type !== 'guest') return { error: jsonResponse({ error: 'Authentication required' }, 401, request) };
  const guestId = body?.booking?.guestId || body?.guestId;
  if (guestId && String(guestId) !== String(session.userId)) return { error: jsonResponse({ error: 'Guest identity mismatch' }, 403, request) };
  const csrf = getCSRFToken(request);
  if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) return { error: jsonResponse({ error: 'Invalid security token' }, 403, request) };
  return { session };
}

// ===== Send booking confirmation email with check‑in code =====
async function sendBookingEmail(guestEmail, guestName, bookingId, homestayName, checkin, checkout, nights, total, checkinCode, env) {
  const html = `
    <h2>Hello ${guestName || 'Guest'},</h2>
    <p>Your booking at <strong>${homestayName}</strong> is confirmed!</p>
    <p><strong>Booking ID:</strong> ${bookingId}</p>
    <p><strong>Check‑in:</strong> ${checkin}</p>
    <p><strong>Check‑out:</strong> ${checkout}</p>
    <p><strong>Nights:</strong> ${nights}</p>
    <p><strong>Total Paid:</strong> RM ${total.toFixed(2)}</p>
    <p style="font-size:20px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
      🏔️ Your 6‑digit check‑in code: <span style="color:#0F382E;">${checkinCode}</span>
    </p>
    <p><strong>Please keep this code safe.</strong> You will need to share it with the host when you arrive. Do not share it with anyone else.</p>
    <p>If you have any questions, please contact us.</p>
    <p>— Kundasang Homestay Team</p>
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
          to: guestEmail,
          subject: 'Booking Confirmed – Your Check‑in Code',
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
          personalizations: [{ to: [{ email: guestEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Booking Confirmed – Your Check‑in Code',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return r.ok;
    }
  } catch (e) {
    console.error('Booking email error:', e.message);
  }
  return false;
}

// ========== GET ==========
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT, version INTEGER DEFAULT 0)').run();

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

    // ===== ADMIN =====
    if (isAdmin) {
      const paginated = bookings.slice(offset, offset + limit);
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
        guests: guests.map(g => { const { password, salt, ...safe } = g; return safe; })
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

    // ===== GUEST =====
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

    // ===== PUBLIC VIEW =====
    const availability = {};
    for (const h of approved) {
      const homestayId = String(h.id);
      availability[homestayId] = bookings
        .filter(b => String(b.homestayId) === homestayId && !/cancelled|failed|expired/i.test(String(b.status || '')))
        .flatMap(b => getDatesInRange(b.checkin, b.checkout));
    }

    return jsonResponse({ approved, availability }, 200, request, {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
    });

  } catch (e) {
    console.error('Bookings GET error:', e.message, e.stack);
    return jsonResponse({ error: 'Failed to load bookings', details: e.message }, 500, request);
  }
}

// ========== POST ==========
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
    if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT, version INTEGER DEFAULT 0)').run();

    const getWithVersion = async key => {
      const r = await db.prepare('SELECT data, version FROM store WHERE key=?').bind(key).first();
      try { return { data: r?.data ? JSON.parse(r.data) : [], version: r?.version || 0 }; } catch(_) { return { data: [], version: 0 }; }
    };

    let attempts = 0;
    const maxAttempts = 5;
    let saved = false;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        const approvedData = await getWithVersion('kd_approved');
        const bookingsData = await getWithVersion('kd_bookings');
        const guestsData = await getWithVersion('kd_guests');

        const approved = approvedData.data;
        const bookings = bookingsData.data;
        const guests = guestsData.data;
        const currentVersion = bookingsData.version;

        const guest = guests.find(g => String(g.id) === String(auth.session.userId));
        const homestay = approved.find(h => String(h.id) === String(incoming.homestayId) && (h.approved === true || h.verified === true));
        if (!guest || !homestay) return jsonResponse({ error: 'Guest or homestay not found' }, 404, request);

        const rooms = homestay.rooms || [];
        let selectedRoom = null;
        if (incoming.roomId) {
          selectedRoom = rooms.find(r => r.id === incoming.roomId);
          if (!selectedRoom) return jsonResponse({ error: 'Selected room not found' }, 400, request);
        }
        const ownerPrice = selectedRoom ? parseFloat(selectedRoom.price) : homestay.ownerPrice;
        if (!Number.isFinite(ownerPrice) || ownerPrice <= 0) {
          return jsonResponse({ error: 'Homestay price is not configured correctly' }, 500, request);
        }

        const ci = String(incoming.checkin || ''), co = String(incoming.checkout || '');
        const d1 = new Date(ci+'T00:00:00'), d2 = new Date(co+'T00:00:00');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ci) || !/^\d{4}-\d{2}-\d{2}$/.test(co) || isNaN(d1) || isNaN(d2) || d1 >= d2) {
          return jsonResponse({ error: 'Invalid dates' }, 400, request);
        }
        const nights = Math.round((d2-d1)/86400000);
        if (nights < 1) return jsonResponse({ error: 'Booking must be at least 1 night' }, 400, request);
        if (nights > MAX_NIGHTS) return jsonResponse({ error: `Maximum booking is ${MAX_NIGHTS} nights` }, 400, request);
        const today = new Date(); today.setHours(0,0,0,0);
        if (d1 < today) return jsonResponse({ error: 'Cannot book past dates' }, 400, request);

        const existingPending = bookings.find(b =>
          String(b.guestId) === String(guest.id) &&
          String(b.homestayId) === String(homestay.id) &&
          b.checkin === ci &&
          b.checkout === co &&
          b.status === 'Pending Payment'
        );
        if (existingPending) {
          return jsonResponse({
            success: true,
            booking: existingPending,
            alreadyExists: true,
            message: 'You already have a pending booking for these dates. Please complete the payment.'
          }, 200, request);
        }

        const homestayBlocked = new Set((homestay.blockedDates || []).map(String));
        const requestedDates = getDatesInRange(ci, co);
        for (const ds of requestedDates) {
          if (homestayBlocked.has(ds)) {
            return jsonResponse({ error: `Selected dates are unavailable (${ds}) due to homestay block` }, 409, request);
          }
        }

        if (selectedRoom) {
          const roomBlocked = new Set((selectedRoom.blockedDates || []).map(String));
          for (const ds of requestedDates) {
            if (roomBlocked.has(ds)) {
              return jsonResponse({ error: `Room "${selectedRoom.name}" is blocked on ${ds}` }, 409, request);
            }
          }
        }

        const overlaps = bookings.some(b => {
          const pendingExpired = String(b.status||'') === 'Pending Payment' && b.date && Date.now() - Date.parse(b.date) > 15*60*1000;
          const isOwnPending = String(b.guestId) === String(guest.id) && b.status === 'Pending Payment';
          const roomMatch = selectedRoom ? String(b.roomId) === String(selectedRoom.id) : String(b.homestayId) === String(homestay.id);
          return roomMatch &&
                 !pendingExpired &&
                 !/cancelled|failed|expired/i.test(String(b.status||'')) &&
                 !isOwnPending &&
                 ci < String(b.checkout||'') &&
                 co > String(b.checkin||'');
        });
        if (overlaps) {
          return jsonResponse({ error: 'Selected dates are already booked for this room' }, 409, request);
        }

        const base = Math.round(ownerPrice * nights * 100) / 100;
        const fee = Math.round(base * 0.11 * 100) / 100;
        const gatewayFee = 1.00;
        const total = Math.round((base + fee + gatewayFee) * 100) / 100;
        let bookingId = String(incoming.id || '');
        if (!/^KDH-[A-Za-z0-9_-]{4,40}$/.test(bookingId) || bookings.some(b=>String(b.id)===bookingId)) {
          bookingId = `KDH-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
        }

        const checkinCode = String(Math.floor(100000 + Math.random() * 900000));

        const booking = {
          id: bookingId,
          homestay: homestay.name,
          homestayId: homestay.id,
          ownerWhatsapp: homestay.whatsapp || '',
          guestId: guest.id,
          guestName: guest.name,
          guestEmail: guest.email,
          guestPhone: guest.phone || '',
          checkin: ci,
          checkout: co,
          nights,
          base,
          fee,
          gatewayFee,
          total,
          status: 'Pending Payment',
          date: new Date().toISOString(),
          checkinCode: checkinCode,
          roomId: selectedRoom ? selectedRoom.id : null,
          roomName: selectedRoom ? selectedRoom.name : null,
          roomImages: selectedRoom ? (selectedRoom.images || []) : []  // <-- Store room images
        };
        
        bookings.push(booking);
        const newData = JSON.stringify(bookings);
        const newVersion = currentVersion + 1;

        const updateStmt = await db.prepare(
          'UPDATE store SET data = ?, version = ? WHERE key = ? AND version = ?'
        ).bind(newData, newVersion, 'kd_bookings', currentVersion);

        const result = await updateStmt.run();

        if (result.changes === 0) {
          console.log(`🔄 Booking race condition detected. Retry attempt ${attempts} for ${bookingId}`);
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        saved = true;

        await sendBookingEmail(guest.email, guest.name, bookingId, homestay.name, ci, co, nights, total, checkinCode, env)
          .catch(e => console.warn('Email send failed:', e));

        try {
          const guestPhoneClean = String(guest.phone || '').replace(/[^0-9]/g, '');
          if (guestPhoneClean && guestPhoneClean.length >= 9) {
            let phone = guestPhoneClean;
            if (phone.startsWith('0')) phone = '60' + phone.substring(1);
            const msg = `*Kundasang Homestay Booking Confirmed!* 🏔️\n\nBooking ID: ${bookingId}\nHomestay: ${homestay.name}\nCheck-in: ${ci}\nCheck-out: ${co}\n\n*Your 6-digit check-in code:* ${checkinCode}\n\nPlease keep this code safe. You will need to share it with the host when you arrive. Do not share it with anyone else.`;
            fetch(`https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(msg)}`, { method: 'GET' }).catch(()=>{});
          }
        } catch (waError) { console.warn('WhatsApp notification failed:', waError); }

        await logAction({db,action:'booking_created',admin:'guest',details:`Booking ${booking.id} created; payment pending`,ip:getClientIP(request),userId:guest.id,homestayId:homestay.id});
        return jsonResponse({success:true, booking}, 200, request);

      } catch(e) {
        console.error('Create booking error:', e.message);
        if (attempts === maxAttempts) {
          return jsonResponse({ error: 'Could not create booking' }, 500, request);
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (!saved) {
      return jsonResponse({ error: 'Could not save booking after multiple attempts' }, 503, request);
    }
  }

  // ... rest of the POST handler (publicUpdateStatus, admin actions) unchanged ...
  // (keep the existing code for other actions)
  if (action === "publicUpdateStatus" && body.id) {
    // unchanged
  }

  // ADMIN actions unchanged (including deleteGuest)
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  // ... unchanged admin actions ...
  // (the file continues with the rest of the admin actions)
}
