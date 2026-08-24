// /functions/api/_utils.js
const PEPPER = "kundasang-homestay-2026";

export async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateSalt() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 10) + crypto.randomUUID().slice(0, 8);
}

export function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

export function corsHeaders(request) {
  const ALLOWED_ORIGINS = [
    'https://kundasanghomestay.my',
    'https://kundasanghomestay.pages.dev',
    'http://localhost:5173'
  ];
  const origin = request?.headers?.get('Origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Owner-Authorization, X-Toyyibpay-Secret, X-CSRF-Token',
    'Access-Control-Max-Age': '86400'
  };
  if (isAllowed) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

export function enforceHttps(request) {
  const url = new URL(request.url);
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  return null;
}

export async function logAction({ db, action, admin, details, ip, userId, homestayId }) {
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        action TEXT,
        admin TEXT,
        user_id TEXT,
        homestay_id TEXT,
        details TEXT,
        ip TEXT
      )
    `).run();
    await db.prepare(`
      INSERT INTO audit_log (timestamp, action, admin, user_id, homestay_id, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      new Date().toISOString(),
      action,
      admin || 'system',
      userId || null,
      homestayId || null,
      details || '',
      ip || 'unknown'
    ).run();
    return true;
  } catch(e) {
    console.error('Audit log failed:', e.message);
    return false;
  }
}
