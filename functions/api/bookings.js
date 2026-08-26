// ========== GET – Debug version ==========
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const adminAuth = await verifyAdmin(request, env);
  const isAdmin = adminAuth === null;
  const guestSession = isAdmin ? null : await getGuestSession(request, env);
  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // Batch read all needed keys
    const keys = ['kd_bookings', 'kd_approved'];
    const stmts = keys.map(key => db.prepare('SELECT data FROM store WHERE key = ?').bind(key));
    const results = await db.batch(stmts);

    const dataMap = {};
    keys.forEach((key, index) => {
      const row = results[index]?.results?.[0];
      try { dataMap[key] = row?.data ? JSON.parse(row.data) : []; } catch (_) { dataMap[key] = []; }
    });

    const bookings = dataMap['kd_bookings'];
    const approved = dataMap['kd_approved'];

    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const limit = parseInt(url.searchParams.get('limit')) || DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * limit;

    if (isAdmin) {
      // ... keep your existing admin logic (not shown for brevity) or use the full version
      // For debugging, we can just return a minimal admin response
      const paginated = bookings.slice(offset, offset + limit);
      return jsonResponse({
        bookings: paginated,
        total: bookings.length,
        page,
        limit,
        totalPages: Math.ceil(bookings.length / limit),
        approved,
        // ... other keys if needed
      }, 200, request, { 'Cache-Control': 'no-store' });
    }

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

    // ✅ PUBLIC VIEW – compute availability
    const availability = {};
    for (const h of approved) {
      const homestayId = String(h.id);
      availability[homestayId] = bookings
        .filter(b => String(b.homestayId) === homestayId && !/cancelled|failed|expired/i.test(String(b.status || '')))
        .flatMap(b => getDatesInRange(b.checkin, b.checkout));
    }

    // ✅ Include debug info
    return jsonResponse({
      approved,
      availability,
      debug: {
        bookingsCount: bookings.length,
        approvedCount: approved.length,
        availabilityKeys: Object.keys(availability).length,
        isAdmin,
        hasGuestSession: !!guestSession
      }
    }, 200, request, {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
    });

  } catch (e) {
    console.error('Bookings GET error:', e.message, e.stack);
    // Include the error message in the response for debugging
    return jsonResponse({ 
      error: 'Failed to load bookings',
      debug: { errorMessage: e.message, stack: e.stack }
    }, 500, request);
  }
}
