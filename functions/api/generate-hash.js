// /api/generate-hash.js
import { hashPassword } from './_utils.js';

export async function onRequestGet({ request, env }) {
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
