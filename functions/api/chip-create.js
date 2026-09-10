// /api/chip-create.js – Smart retry + rate limiting + generic errors + paid-discovery email
import {
  corsHeaders,
  enforceHttps,
  getClientIP,
  getGuestSession,
  logAction,
  getCSRFToken,
  validateCSRFToken,
  jsonResponse,
  checkRateLimit,
  recordRateLimit,
  withLock,
  finalizePaidBooking
} from './_utils.js';

// ============================================================
// Email helper – used when we discover an already-paid purchase
// but the webhook/verify-payment never ran.
// ============================================================
async function sendCheckinCodeEmail(to, guestName, bookingId, checkinCode, homestayName, checkin, checkout, env) {
  const html = `
    <h2>Hello ${guestName || 'Guest'},</h2>
    <p>Your booking <strong>${bookingId}</strong> at <strong>${homestayName}</strong> has been paid successfully.</p>
    <p><strong>Check‑in:</strong> ${checkin}</p>
    <p><strong>Check‑out:</strong> ${checkout}</p>
    <p style="font-size:24px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
      🏔️ Your 6‑digit check‑in code: <span style="color:#0F382E;">${checkinCode}</span>
    </p>
    <p>Please present this code to the host upon arrival.</p>
    <p>Thank you for booking with Kundasang Homestay!</p>
  `;
  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: to,
          subject: 'Your Check‑in Code – Payment Confirmed',
          html
        })
      });
      return r.ok;
    }
    if (env.SENDGRID_API_KEY) {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Your Check‑in Code – Payment Confirmed',
          content: [{ type: 'text/html', value: html }]
        })
      });
      return r.ok;
    }
  } catch (e) {
    console.error('Email send error:', e.message);
  }
  return false;
}

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

    // Rate limiting per guest and booking
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

    // Already paid
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({
        success: true,
        alreadyPaid: true,
        message: 'This booking is already paid.',
        bookingId: booking.id
      }, 200, request);
    }

    const chipSecret = env.CHIP_SECRET_KEY;
    if (!chipSecret) {
      return jsonResponse({ error: 'Payment service unavailable. Please try again later.' }, 500, request);
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

          // ============================================================
          // Already paid – update booking, generate code if missing,
          // send email if we just generated the code.
          // ============================================================
          if (status === 'paid' || status === 'completed') {
            let finalizeResult;
            try {
              finalizeResult = await withLock(db, `paid-${booking.id}`, async (db) => {
                return await finalizePaidBooking(db, booking.id);
              }, 10000);
            } catch (lockErr) {
              if (lockErr.message && lockErr.message.includes('in progress')) {
                await new Promise(r => setTimeout(r, 800));
                const rr = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
                let bb = [];
                try { if (rr?.data) bb = JSON.parse(rr.data); } catch(_) {}
                const cur = bb.find(b => String(b.id) === String(booking.id));
                if (cur && (cur.status === 'Paid - Awaiting Check-in' || String(cur.status).startsWith('Completed'))) {
                  finalizeResult = { alreadyFinalized: true, booking: cur };
                } else {
                  throw lockErr;
                }
              } else {
                throw lockErr;
              }
            }

            if (finalizeResult.finalized && finalizeResult.codeWasMissing) {
              try {
                await sendCheckinCodeEmail(
                  finalizeResult.booking.guestEmail,
                  finalizeResult.booking.guestName || 'Guest',
                  finalizeResult.booking.id,
                  finalizeResult.checkinCode,
                  finalizeResult.booking.homestay || 'Kundasang Homestay',
                  finalizeResult.booking.checkin,
                  finalizeResult.booking.checkout,
                  env
                );
              } catch (mailErr) {
                console.error('Check-in email failed:', mailErr.message);
              }
            }

            await logAction({
              db,
              action: 'chip_payment_already_paid',
              admin: 'guest',
              details: `Booking ${booking.id} found paid in CHIP via chip-create; ${finalizeResult.finalized ? 'finalized' : 'already finalized'}`,
              ip: clientIP,
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
            } else if (purchase.checkout_url) {
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
          // Fall through to create new purchase for cancelled/expired/failed
        }
      } catch (e) {
        // Fall through to create new purchase
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
      success_callback: `${domain}/api/chip-webhook`
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
      return jsonResponse({ error: 'Payment gateway error. Please try again.' }, 502, request);
    }

    bookings[idx] = {
      ...booking,
      chip_purchase_id: data.id,
      chip_checkout_url: data.checkout_url,
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
      ip: clientIP,
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
    console.error('CHIP create error:', error.message);
    return jsonResponse({ error: 'Payment setup failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
