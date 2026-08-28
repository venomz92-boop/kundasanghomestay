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

    // 4. Retrieve bookings
    const result = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try {
      if (result?.data) bookings = JSON.parse(result.data);
    } catch (_) {
      return jsonResponse({ success: false, error: 'Failed to parse booking data' }, 500, request);
    }
    if (!Array.isArray(bookings)) {
      return jsonResponse({ success: false, error: 'Invalid booking store' }, 500, request);
    }

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
    // If the booking doesn't have a checkinCode, generate one now (shouldn't happen, but for safety)
    let storedCode = booking.checkinCode || null;
    if (!storedCode) {
      // Generate a new code
      storedCode = Math.floor(100000 + Math.random() * 900000).toString();
      bookings[idx].checkinCode = storedCode;
      // Save to DB before comparing? We'll compare and save later.
    }

    // Compare codes (string comparison)
    if (checkinCode !== storedCode) {
      return jsonResponse({ 
        success: false, 
        error: 'Invalid check‑in code. Please ask the guest for the correct 6‑digit code.' 
      }, 400, request);
    }

    // 8. Update booking to checked-in / completed
    bookings[idx] = {
      ...booking,
      status: 'Completed',
      checkinCode: storedCode, // keep the code for reference
      checkedInAt: new Date().toISOString(),
      checkedInBy: 'owner' // optionally store owner info
    };

    // 9. Save to DB
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    // 10. Log the action
    await logAction({
      db,
      action: 'owner_checkin',
      admin: 'owner',
      details: `Checked in booking ${bookingId} with code ${checkinCode}`,
      ip: getClientIP(request),
      userId: booking.guestId,
      homestayId: booking.homestayId
    });

    return jsonResponse({
      success: true,
      message: `Check‑in confirmed for ${booking.guestName || 'guest'}. Booking is now completed.`
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
