// /api/admin-errors.js
//
// Returns recent server errors captured by /api/_middleware.js.
// Also supports DELETE to clear the log.
//
// Admin-only. Uses the same verifyAdminAuth helper as every other
// admin endpoint.
import {
  corsHeaders,
  getClientIP,
  enforceHttps,
  verifyAdminAuth,
  jsonResponse,
  logAction
} from './_utils.js';

const ERRORS_KEY = 'kd_errors';
const MAX_ERRORS = 200;

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const isAdmin = await verifyAdminAuth(request, env);
  if (!isAdmin) return jsonResponse({ error: 'Unauthorized' }, 401, request);

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(ERRORS_KEY).first();
    let errors = [];
    try { if (r?.data) errors = JSON.parse(r.data); } catch (_) {}
    if (!Array.isArray(errors)) errors = [];

    // Newest first.
    const sorted = errors.slice().sort((a, b) => {
      return new Date(b.last_seen || 0) - new Date(a.last_seen || 0);
    });

    return jsonResponse({
      success: true,
      total: sorted.length,
      errors: sorted
    }, 200, request, { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('admin-errors GET error:', e.message);
    return jsonResponse({ error: 'Failed to load errors' }, 500, request);
  }
}

export async function onRequestDelete({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const isAdmin = await verifyAdminAuth(request, env);
  if (!isAdmin) return jsonResponse({ error: 'Unauthorized' }, 401, request);

  const db = env.DB;
  if (!db) return jsonResponse({ error: 'DB not configured' }, 500, request);

  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
      .bind(ERRORS_KEY, JSON.stringify([]))
      .run();

    try {
      await logAction({
        db,
        action: 'errors_cleared',
        admin: 'admin',
        details: 'Admin cleared the server error log',
        ip: getClientIP(request)
      });
    } catch (_) {}

    return jsonResponse({ success: true }, 200, request);
  } catch (e) {
    console.error('admin-errors DELETE error:', e.message);
    return jsonResponse({ error: 'Failed to clear errors' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
