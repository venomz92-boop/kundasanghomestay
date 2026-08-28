// /api/owner-checkin.js
import { corsHeaders, enforceHttps, getClientIP, logAction, jsonResponse } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // 1. Parse request body
    const body = await request.json().catch(() => null);
    if (!body) {
      return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400, request);
    }

    const bookingId = String(body.bookingId || '').trim();
    const checkinCode = String(body.checkinCode || '').trim();

    // 2. Validate required fields
    if (!bookingId) {
      return jsonResponse({ success: false, error: 'Missing bookingId' }, 400, request);
    }
    if (!checkinCode || !/^\d{6}$/.test(checkinCode)) {
      return jsonResponse({ success: false, error: 'Check-in code must be exactly 6 digits' }, 400, request);
    }

    // 3. Get DB
    const db = env.DB;
    if (!db) {
      return jsonResponse({ success: false, error: 'Database not available' }, 500, request);
    }

    // 4. Retrieve bookings and homestays
    const bookingsResult = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    const homestaysResult = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_homestays').first();

    let bookings = [];
    let homestays = [];
    try {
      if (bookingsResult?.data) bookings = JSON.parse(bookingsResult.data);
      if (homestaysResult?.data) homestays = JSON.parse(homestaysResult.data);
    } catch (_) {
      return jsonResponse({ success: false, error: 'Failed to parse store data' }, 500, request);
    }
    if (!Array.isArray(bookings)) bookings = [];
    if (!Array.isArray(homestays)) homestays = [];

    // 5. Find booking
    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx < 0) {
      return jsonResponse({ success: false, error: 'Booking not found' }, 404, request);
    }
    const booking = bookings[idx];

    // 6. Check current status
    if (booking.status === 'Completed' || booking.status === 'Checked-in') {
      return jsonResponse({ success: true, message: 'This booking is already checked in.' }, 200, request);
    }
    if (booking.status !== 'Paid - Awaiting Check-in') {
      return jsonResponse({ success: false, error: `Booking is not ready for check-in (status: ${booking.status})` }, 409, request);
    }

    // 7. Verify the check‑in code
    let storedCode = booking.checkinCode || null;
    if (!storedCode) {
      // Generate a new code if missing (should not happen for new bookings)
      storedCode = Math.floor(100000 + Math.random() * 900000).toString();
      bookings[idx].checkinCode = storedCode;
    }

    if (checkinCode !== storedCode) {
      return jsonResponse({ 
        success: false, 
        error: 'Invalid check‑in code. Please ask the guest for the correct 6‑digit code.' 
      }, 400, request);
    }

    // 8. Find the homestay to get owner payout details
    const homestay = homestays.find(h => String(h.id) === String(booking.homestayId));
    if (!homestay) {
      return jsonResponse({ success: false, error: 'Homestay not found for this booking' }, 404, request);
    }

    // 9. Prepare payout data (owner's share)
    const ownerShare = Math.round(Number(booking.base) * 100); // amount in cents
    const ownerBankCode = homestay.ownerBankCode || null;
    const ownerAccountNumber = homestay.ownerAccountNumber || null;
    const ownerAccountName = homestay.ownerAccountName || homestay.ownerName || 'Owner';

    // 10. Update booking status to 'Completed' and save (pre‑payout)
    bookings[idx] = {
      ...booking,
      status: 'Completed',
      checkinCode: storedCode,
      checkedInAt: new Date().toISOString(),
      checkedInBy: 'owner'
    };
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    // 11. Log check‑in action
    await logAction({
      db,
      action: 'owner_checkin',
      admin: 'owner',
      details: `Checked in booking ${bookingId} with code ${checkinCode}`,
      ip: getClientIP(request),
      userId: booking.guestId,
      homestayId: booking.homestayId
    });

    // 12. Initiate payout (only if bank details exist)
    let payoutSuccess = false;
    let payoutMessage = 'Check‑in confirmed, but payout could not be initiated (missing bank details).';
    let payoutCode = null;

    if (ownerBankCode && ownerAccountNumber && ownerAccountName) {
      const secret = env.TOYYIBPAY_SECRET_KEY;
      const envMode = env.TOYYIBPAY_ENV || 'sandbox';
      const apiBase = envMode === 'production' ? 'https://toyyibpay.com' : 'https://dev.toyyibpay.com';

      // Build payout request
      const payoutParams = new URLSearchParams({
        userSecretKey: secret,
        payoutAmount: String(ownerShare),
        payoutBankCode: ownerBankCode,
        payoutAccountNumber: ownerAccountNumber,
        payoutName: ownerAccountName,
        payoutReferenceNo: bookingId,
        payoutDescription: `Payout for booking ${bookingId} - ${booking.homestay || 'Homestay'}`,
        payoutCallbackUrl: `${env.PUBLIC_DOMAIN || ''}/api/toyyibpay-payout-webhook`
      });

      try {
        const payoutResponse = await fetch(`${apiBase}/index.php/api/createPayout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: payoutParams
        });
        const payoutData = await payoutResponse.json().catch(() => null);
        if (payoutResponse.ok && payoutData && payoutData[0]?.PayoutCode) {
          payoutCode = payoutData[0].PayoutCode;
          payoutSuccess = true;
          payoutMessage = `Check‑in confirmed, payout initiated. Payout reference: ${payoutCode}`;

          // Update booking with payout code
          bookings[idx] = {
            ...bookings[idx],
            ownerPayoutId: payoutCode,
            payoutInitiatedAt: new Date().toISOString()
          };
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          await logAction({
            db,
            action: 'payout_initiated',
            admin: 'owner',
            details: `Payout ${payoutCode} initiated for booking ${bookingId}, amount RM${(ownerShare/100).toFixed(2)}`,
            ip: getClientIP(request),
            userId: booking.guestId,
            homestayId: booking.homestayId
          });
        } else {
          console.error('Payout API error:', payoutData);
          payoutMessage = `Check‑in confirmed, but payout failed: ${payoutData?.error || 'Unknown error'}`;
        }
      } catch (e) {
        console.error('Payout request error:', e.message);
        payoutMessage = `Check‑in confirmed, but payout request encountered an error: ${e.message}`;
      }
    } else {
      // Missing bank details – log and skip
      console.warn('Missing owner bank details for homestay', homestay.id);
      await logAction({
        db,
        action: 'payout_skipped',
        admin: 'owner',
        details: `Payout skipped for booking ${bookingId} – missing bank details for owner ${homestay.ownerName || 'unknown'}`,
        ip: getClientIP(request),
        userId: booking.guestId,
        homestayId: booking.homestayId
      });
    }

    // 13. Return final response
    return jsonResponse({
      success: true,
      message: payoutMessage,
      payoutSuccess: payoutSuccess,
      payoutCode: payoutCode,
      bookingId: bookingId
    }, 200, request);

  } catch (error) {
    console.error('owner-checkin error:', error.message, error.stack);
    return jsonResponse({ 
      success: false, 
      error: 'Server error: ' + error.message 
    }, 500, request);
  }
}

// OPTIONS handler (CORS)
export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
