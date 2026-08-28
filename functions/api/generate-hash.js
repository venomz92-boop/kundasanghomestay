// /api/generate-hash.js
import { hashPassword, getAdminToken } from './_utils.js';

export async function onRequestGet({ request, env }) {
  // 🔒 Admin only
  const token = await getAdminToken(request);
  if (!token || token !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const url = new URL(request.url);
  const password = url.searchParams.get('password') || 'password123';
  const hashed = await hashPassword(password, env);
  return new Response(JSON.stringify({
    password,
    hash: hashed.hash,
    salt: hashed.salt,
    algorithm: hashed.algorithm
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
