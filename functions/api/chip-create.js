// /api/chip-create.js – Smart retry + rate limiting
import { corsHeaders, enforceHttps, getClientIP, getGuestSession, logAction, getCSRFToken, validateCSRFToken, jsonResponse, checkRateLimit, recordRateLimit } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    const csrf = getCSRFToken(request);
    if (!csrf || !(await validateCSRFToken(csrf, session.userId, env))) {
      return jsonResponse({ error: 'Invalid security token' }, 403, request);
    }

    const { bookingId } = await request.json();
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);

    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ===== SECURITY: Rate limiting per guest and booking =====
    const clientIP = getClientIP(request);
    const rateKey = `chip_create_${bookingId}`;
    const rateOk = await checkRateLimit(db, clientIP, rateKey, 3, 5 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many payment attempts. Please wait 5 minutes.' }, 429, request);
    }
    await recordRateLimit(db, clientIP, rateKey);

    // Load bookings
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId) && String(b.guestId) === String(session.userId));
    if (idx === -1) return jsonResponse({ error: 'Booking not found' }, 404, request);

    const booking = bookings[idx];

    // If already paid, just confirm and return
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({
        success: true,
        alreadyPaid: true,
        message: 'This booking is already paid.',
        bookingId: booking.id
      }, 200, request);
    }

    // Check if we already have a CHIP purchase ID
    const chipSecret = env.CHIP_SECRET_KEY;
    if (!chipSecret) {
      return jsonResponse({ error: 'Payment gateway not configured. Contact support.' }, 500, request);
    }

    let existingPurchaseId = booking.chip_purchase_id;
    let existingCheckoutUrl = booking.chip_checkout_url;

    // If we have an existing purchase, query its status
    if (existingPurchaseId) {
      try {
        const resp = await fetch(`https://gate.chip-in.asia/api/v1/purchases/${existingPurchaseId}/`, {
          headers: { 'Authorization': `Bearer ${chipSecret}` }
        });
        if (resp.ok) {
          const purchase = await resp.json();
          const status = purchase.status;

          // Already paid – update booking
          if (status === 'paid' || status === 'completed') {
            bookings[idx] = {
              ...booking,
              status: 'Paid - Awaiting Check-in',
              paid_at: new Date().toISOString(),
              chip_status: 'paid'
            };
            await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
              .bind('kd_bookings', JSON.stringify(bookings))
              .run();

            await logAction({
              db,
              action: 'chip_payment_already_paid',
              admin: 'guest',
              details: `Booking ${booking.id} found paid in CHIP; status updated`,
              ip: getClientIP(request),
              userId: session.userId,
              homestayId: booking.homestayId
            });

            return jsonResponse({
              success: true,
              alreadyPaid: true,
              message: 'Payment already completed.',
              bookingId: booking.id
            }, 200, request);
          }

          // Still pending – return existing checkout URL
          if (['created', 'sent', 'viewed'].includes(status)) {
            if (existingCheckoutUrl) {
              return jsonResponse({
                success: true,
                url: existingCheckoutUrl,
                alreadyPaid: false,
                message: 'Resuming existing payment session.'
              }, 200, request);
            } else {
              // We have the ID but no URL – we could try to fetch it from the purchase object
              // The purchase object has a `checkout_url` field; we can use that.
              if (purchase.checkout_url) {
                // Store it for future use
                bookings[idx].chip_checkout_url = purchase.checkout_url;
                await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
                  .bind('kd_bookings', JSON.stringify(bookings))
                  .run();
                return jsonResponse({
                  success: true,
                  url: purchase.checkout_url,
                  alreadyPaid: false,
                  message: 'Resuming existing payment session.'
                }, 200, request);
              }
            }
          }

          // If purchase is cancelled, expired, or failed, we can create a new one
          // Otherwise, we'll treat it as failed and create a new one.
          console.log(`ℹ️ Existing purchase ${existingPurchaseId} status: ${status}. Creating new purchase.`);
        } else {
          console.warn(`⚠️ Failed to fetch purchase ${existingPurchaseId}: ${resp.status}`);
          // If we can't fetch, assume it's invalid and create a new one.
        }
      } catch (e) {
        console.error('Error checking existing CHIP purchase:', e.message);
        // If error, create a new purchase.
      }
    }

    // ============================================================
    // Create a NEW CHIP purchase
    // ============================================================

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
      skip_thank_you: true,
      platform: 'web',
      success_redirect: `${domain}/?booking=${encodeURIComponent(booking.id)}&payment_return=1`,
      failure_redirect: `${domain}/?booking=${encodeURIComponent(booking.id)}&payment=cancel`,
      cancel_redirect: `${domain}/?booking=${encodeURIComponent(booking.id)}&payment=cancel`,
      success_callback: `${domain}/api/chip-webhook`  // Webhook will also fire
    };

    const response = await fetch(CHIP_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${chipSecret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok || !data.id) {
      console.error('CHIP create purchase error:', data);
      return jsonResponse({ error: 'Payment gateway error. Please try again.' }, 502, request);
    }

    // Update booking with new purchase details
    bookings[idx] = {
      ...booking,
      chip_purchase_id: data.id,
      chip_checkout_url: data.checkout_url,   // store for later reuse
      chip_status: data.status || 'pending',
      paymentProvider: 'CHIP'
    };
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    await logAction({
      db,
      action: 'chip_purchase_created',
      admin: 'guest',
      details: `New purchase ${data.id} created for ${booking.id}`,
      ip: getClientIP(request),
      userId: session.userId,
      homestayId: booking.homestayId
    });

    return jsonResponse({
      success: true,
      url: data.checkout_url,
      purchase_id: data.id,
      bookingId: booking.id,
      amount: Number(booking.total)
    }, 200, request);

  } catch (error) {
    console.error('CHIP create error:', error.message, error.stack);
    return jsonResponse({ error: 'Payment setup failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
