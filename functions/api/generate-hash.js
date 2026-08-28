// /api/generate-hash.js
import { hashPassword, getAdminToken } from './_utils.js';

export async function onRequestGet({ request, env }) {
  const token = await getAdminToken(request);
  if (!token || token !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
    headers: { 'Content-Type': 'application/json' }
  });
}
