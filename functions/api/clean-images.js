// /api/clean-images.js
import { corsHeaders, getAdminToken, jsonResponse } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const token = await getAdminToken(request);
  if (!token || token !== env.ADMIN_TOKEN) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request);
  }

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    const keys = ['kd_approved', 'kd_bookings'];
    const results = {};
    for (const key of keys) {
      const row = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
      results[key] = row?.data ? JSON.parse(row.data) : [];
    }

    let approved = results['kd_approved'];
    let bookings = results['kd_bookings'];

    // ===== CLEAN APPROVED HOMESTAYS =====
    let cleanedApproved = approved.map(h => {
      // Remove ALL image fields
      const {
        images,         // homestay gallery
        icImage,        // IC photo
        bankQRImage,    // Bank QR
        pbtLicense,     // PBT license
        ...rest
      } = h;

      // Remove room images
      if (rest.rooms && Array.isArray(rest.rooms)) {
        rest.rooms = rest.rooms.map(r => {
          const { images: roomImages, ...roomRest } = r;
          return roomRest;
        });
      }
      return rest;
    });

    // ===== CLEAN BOOKINGS =====
    let cleanedBookings = bookings.map(b => {
      const { roomImages, ...rest } = b;
      return rest;
    });

    // ===== UPDATE DATABASE =====
    const stmt1 = db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_approved', JSON.stringify(cleanedApproved));
    const stmt2 = db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_bookings', JSON.stringify(cleanedBookings));
    await db.batch([stmt1, stmt2]);

    return jsonResponse({
      success: true,
      message: 'All images removed from approved and bookings.',
      approvedCount: cleanedApproved.length,
      bookingsCount: cleanedBookings.length,
      oldSize: results['kd_approved'].length,
      newSize: JSON.stringify(cleanedApproved).length
    }, 200, request);

  } catch (e) {
    console.error('❌ Clean images error:', e.message);
    return jsonResponse({ error: e.message }, 500, request);
  }
}

export async function onRequestGet({ request, env }) {
  return new Response('Use POST to clean images. Admin auth required.', {
    status: 200,
    headers: corsHeaders(request)
  });
}
