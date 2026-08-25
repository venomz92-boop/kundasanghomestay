// /functions/api/_utils.js
// =============================================================
// SHARED UTILITIES – All API endpoints import from here
// =============================================================

const PEPPER = "kundasang-homestay-2026";  // Optional – used by some endpoints, kept here for consistency

// ---- SHA256 hashing ----
export async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- Generate unique salt per user ----
export function generateSalt() {
  return Date.now().toString(36) + 
         Math.random().toString(36).substring(2, 10) + 
         crypto.randomUUID().slice(0, 8);
}

// ---- Get client IP ----
export function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || 
         request.headers.get('X-Forwarded-For') || 
         'unknown';
}

// ---- SECURE CORS ----
export function corsHeaders(request) {
  const ALLOWED_ORIGINS = [
    'https://kundasanghomestay.my',
    'https://kundasanghomestay.pages.dev',
    'http://localhost:5173' // For local dev
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

// ---- HTTPS Enforcement ----
export function enforceHttps(request) {
  const url = new URL(request.url);
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  return null;
}

// ---- Audit Logging ----
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

// /functions/api/_utils.js - ADD THESE FUNCTIONS

// =============================================================
// CSRF TOKEN GENERATION & VALIDATION
// =============================================================

// Generate a CSRF token for a session
export function generateCSRFToken(userId) {
  const timestamp = Date.now();
  const random = crypto.randomUUID().slice(0, 16);
  const data = `${userId}|${timestamp}|${random}`;
  // Simple base64 encoding (not cryptographic, just for transport)
  return btoa(data);
}

// Validate a CSRF token
export function validateCSRFToken(token, userId) {
  if (!token || !userId) return false;
  try {
    const decoded = atob(token);
    const parts = decoded.split('|');
    if (parts.length !== 3) return false;
    const [tokenUserId, timestamp] = parts;
    if (tokenUserId !== String(userId)) return false;
    // Token expires after 24 hours
    const age = Date.now() - parseInt(timestamp);
    if (isNaN(age) || age > 24 * 60 * 60 * 1000) return false;
    return true;
  } catch(e) {
    return false;
  }
}

// Get CSRF token from request (headers or body)
export function getCSRFToken(request) {
  const header = request.headers.get('X-CSRF-Token');
  if (header) return header;
  // Fallback: check body (for JSON requests)
  return null;
}

// =============================================================
// Also add this to your existing corsHeaders function
// =============================================================
// In corsHeaders(), add to allowed headers:
// 'X-CSRF-Token'
