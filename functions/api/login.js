import { 
  corsHeaders, getClientIP, enforceHttps, hashPassword, verifyPassword,
  createSignedToken, generateCSRFToken, cookieHeader, jsonResponse,
  checkRateLimit, recordRateLimit, parseJSONSafely, incrementSessionVersion 
} from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);

    const rateOk = await checkRateLimit(db, clientIP, 'login', 10, 600);
    if (!rateOk) return jsonResponse({ error: 'Too many attempts' }, 429, request);

    const { email, password } = await parseJSONSafely(request);
    const cleanEmail = String(email || '').toLowerCase().trim();

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = JSON.parse(r?.data || '[]');

    const user = guests.find(g => String(g.email || '').toLowerCase() === cleanEmail);
    if (!user) {
      await recordRateLimit(db, clientIP, 'login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    const verified = await verifyPassword(password, user, env);
    if (!verified.ok) {
      await recordRateLimit(db, clientIP, 'login');
      return jsonResponse({ error: 'Invalid credentials' }, 401, request);
    }

    if (verified.legacy) {
      const fresh = await hashPassword(password, env);
      user.password = fresh.hash;
      user.salt = fresh.salt;
      user.passwordAlgorithm = fresh.algorithm;
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)').bind('kd_guests', JSON.stringify(guests)).run();
    }

    if (user.verified !== true) return jsonResponse({ error: 'Verify email first' }, 403, request);

    await incrementSessionVersion(db, user.id, 'guest');
    const sessionToken = await createSignedToken({
      type: 'guest', userId: String(user.id), email: user.email, sessionVersion: (user.sessionVersion || 0) + 1
    }, env);

    const csrfToken = await generateCSRFToken(user.id, env);
    const { password: _, salt: __, ...safeUser } = user;

    return new Response(JSON.stringify({ success: true, guest: safeUser, token: sessionToken, csrfToken }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Set-Cookie': cookieHeader('guest_token', sessionToken) }
    });
  } catch (e) {
    return jsonResponse({ error: 'Login failed' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
