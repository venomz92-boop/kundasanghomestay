// /api/debug-user.js
import { corsHeaders } from './_utils.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const email = url.searchParams.get('email') || '';
  const db = env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: 'DB not configured' }), {
      status: 500,
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
