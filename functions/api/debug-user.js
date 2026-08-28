// /api/debug-user.js
import { corsHeaders, getAdminToken } from './_utils.js';

export async function onRequestGet({ request, env }) {
  const token = await getAdminToken(request);
  if (!token || token !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: corsHeaders(request)
    });
  }

  try {
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_guests').first();
    let guests = [];
    if (r?.data) { try { guests = JSON.parse(r.data); } catch(_) {} }
    
    const user = guests.find(g => String(g.email || '').toLowerCase() === email.toLowerCase());
    if (!user) {
      return new Response(JSON.stringify({ exists: false, message: 'User not found' }), {
        status: 404,
        headers: corsHeaders(request)
      });
    }
    
    // Return user without password/salt
    const { password, salt, ...safeUser } = user;
    return new Response(JSON.stringify({ exists: true, user: safeUser }), {
      status: 200,
      headers: corsHeaders(request)
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
}
