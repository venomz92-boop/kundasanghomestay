// /functions/api/lib/csrf.js
// CSRF token generation and validation

import { createSignedToken, verifySignedToken } from './crypto.js';

/**
 * Generate CSRF token for a user
 * @param {string} userId 
 * @param {Object} env 
 * @returns {Promise<string>}
 */
export async function generateCSRFToken(userId, env) {
  return createSignedToken({ type: 'csrf', userId: String(userId) }, env, 24 * 60 * 60 * 1000);
}

/**
 * Validate CSRF token
 * @param {string} token 
 * @param {string} userId 
 * @param {Object} env 
 * @returns {Promise<boolean>}
 */
export async function validateCSRFToken(token, userId, env) {
  const data = await verifySignedToken(token, env);
  return !!data && data.type === 'csrf' && String(data.userId) === String(userId);
}
