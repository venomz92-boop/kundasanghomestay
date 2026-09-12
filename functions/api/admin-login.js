// /api/admin-login.js — Plain English: this file now hashes BOTH the
// password you typed and the real admin password with SHA-256 first, then
// compares the two 32-byte digests in constant time. This hides how long
// the real password is from anyone trying to guess it. Everything else
// (cookie, token, rate limiting) is unchanged.
import {
  corsHeaders,
  getClientIP,
  enforceHttps,
  cookieHeader,
  jsonResponse,
  checkRateLimit,
  recordRateLimit,
  parseJSONSafely,
  createAdminToken
} from './_utils.js';

const ADMIN_TTL_SECONDS = 8 * 60 * 60; // 8 hours

// H6: SHA-256 both inputs and constant-time compare the fixed-length
// digests. This removes the previous length-based early return, which
// leaked the admin password length via timing.
async function sha256Bytes(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

function constantTimeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server configuration error' }, 500, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    const rateOk = await checkRateLimit(db, clientIP, 'admin_login', 5, 15 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many login attempts. Please wait 15 minutes.' }, 429, request);
    }

    const { password } = await parseJSONSafely(request);

    if (!password || typeof password !== 'string') {
      await recordRateLimit(db, clientIP, 'admin_login');
      return jsonResponse({ error: 'Invalid credentials' }, 400, request);
    }

    const adminPass = env.ADMIN_PASSWORD;
    if (!adminPass) {
      console.error('ADMIN_PASSWORD environment variable is not set!');
      return jsonResponse({ error: 'Server configuration error. Please contact support.' }, 500, request);
    }

    // H6: hash-then-compare-in-constant-time.
    const [inputDigest, expectedDigest] = await Promise.all([
      sha256Bytes(password),
      sha256Bytes(adminPass)
    ]);

    if (!constantTimeEqualBytes(inputDigest, expectedDigest)) {
      await recordRateLimit(db, clientIP, 'admin_login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    // Signed, expiring token — cannot be replayed after 8 hours
    const token = await createAdminToken({ type: 'admin', role: 'owner' }, env);

    console.log(`Admin login successful (IP: ${clientIP})`);

    return new Response(JSON.stringify({
      success: true,
      token: token,
      expiresIn: ADMIN_TTL_SECONDS,
      message: 'Login successful'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieHeader('admin_token', token, ADMIN_TTL_SECONDS),
        ...corsHeaders(request)
      }
    });
  } catch (e) {
    console.error('Admin login error:', e.message);
    return jsonResponse({ error: 'Login failed. Please try again later.' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
