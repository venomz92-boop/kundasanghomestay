// /api/chip-create.js
import { corsHeaders, enforceHttps, getClientIP, getGuestSession, logAction, getCSRFToken, validateCSRFToken, jsonResponse } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // 1. Auth
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    // 2. CSRF
    const csrf = getCSRFToken(request);
    if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) {
      return jsonResponse({ error: 'Invalid security token' }, 403, request);
    }

    const { bookingId } = await request.json();
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // 3. Fetch booking
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId) && String(b.guestId) === String(session.userId));
    if (idx === -1) return jsonResponse({ error: 'Booking not found' }, 404, request);

    const booking = bookings[idx];
    if (!['Pending Payment', 'Payment Failed'].includes(booking.status)) {
      return jsonResponse({ error: `Booking is not awaiting payment (status: ${booking.status})` }, 409, request);
    }

    // 4. CHIP Collect API call
    const CHIP_API = 'https://gate.chip-in.asia/api/v1/purchases/';
    const amountCents = Math.round(Number(booking.total) * 100);
    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';

    const payload = {
      client: {
        email: booking.guestEmail || session.email,
        full_name: booking.guestName || 'Guest'
      },
      purchase: {
        products: [
          {
            name: `${booking.homestay} (${booking.checkin} to ${booking.checkout})`,
            price: amountCents,
            quantity: 1
          }
        ]
      },
      brand_id: env.CHIP_BRAND_ID,
      skip_thank_you: 1,
      success_url: `${domain}/?booking=${encodeURIComponent(booking.id)}&payment=success`,
      cancel_url: `${domain}/?booking=${encodeURIComponent(booking.id)}&payment=cancel`,
      webhook: `${domain}/api/chip-webhook`
    };

    const response = await fetch(CHIP_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CHIP_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok || !data.id) {
      console.error('CHIP create purchase error:', data);
      return jsonResponse({ error: 'Payment gateway error. Please try again.' }, 502, request);
    }

    // 5. Update booking with purchase_id
    bookings[idx] = {
      ...booking,
      chip_purchase_id: data.id,
      chip_status: 'pending',
      paymentProvider: 'CHIP'
    };
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    await logAction({
      db,
      action: 'chip_purchase_created',
      admin: 'guest',
      details: `Purchase ${data.id} created for ${booking.id}`,
      ip: getClientIP(request),
      userId: session.userId,
      homestayId: booking.homestayId
    });

    // 6. Return checkout URL
    return jsonResponse({
      success: true,
      url: data.checkout_url,
      purchase_id: data.id,
      bookingId: booking.id,
      amount: Number(booking.total)
    }, 200, request);

  } catch (error) {
    console.error('CHIP create error:', error.message, error.stack);
    return jsonResponse({ error: 'Payment setup failed.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
