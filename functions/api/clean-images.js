// /api/clean-images.js
import { corsHeaders, getAdminToken, jsonResponse } from './_utils.js';

export async function onRequestPost({ request, env }) {
  // Verify admin token
  const token = await getAdminToken(request);
  if (!token || token !== env.ADMIN_TOKEN) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request);
  }

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    // Get current data
    const keys = ['kd_approved', 'kd_bookings'];
    const results = {};
    for (const key of keys) {
      const row = await db.prepare('SELECT data FROM store WHERE key = ?').bind(key).first();
      results[key] = row?.data ? JSON.parse(row.data) : [];
    }

    let approved = results['kd_approved'];
    let bookings = results['kd_bookings'];

    // ===== 1. Clean approved homestays =====
    let cleanedApproved = approved.map(h => {
      // Remove homestay-level images
      const { images, ...rest } = h;
      // Remove room images (if rooms exist)
      if (rest.rooms && Array.isArray(rest.rooms)) {
        rest.rooms = rest.rooms.map(r => {
          const { images: roomImages, ...roomRest } = r;
          return roomRest;
        });
      }
      return rest;
    });

    // ===== 2. Clean bookings =====
    let cleanedBookings = bookings.map(b => {
      // Remove roomImages from booking if present
      const { roomImages, ...rest } = b;
      return rest;
    });

    // ===== 3. Update the database =====
    const stmt1 = db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_approved', JSON.stringify(cleanedApproved));
    const stmt2 = db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind('kd_bookings', JSON.stringify(cleanedBookings));
    await db.batch([stmt1, stmt2]);

    return jsonResponse({
      success: true,
      message: 'Images removed from approved and bookings.',
      approvedCount: cleanedApproved.length,
      bookingsCount: cleanedBookings.length
    }, 200, request);

  } catch (e) {
    console.error('❌ Clean images error:', e.message);
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// Also allow GET for quick testing (but keep it secure)
export async function onRequestGet({ request, env }) {
  return new Response('Use POST to clean images. Admin auth required.', {
    status: 200,
    headers: corsHeaders(request)
  });
}
