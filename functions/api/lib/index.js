// /functions/api/lib/index.js
// Central export point for all library modules

export * from './crypto.js';
export * from './http.js';
export * from './validation.js';
export * from './database.js';
export * from './csrf.js';
export * from './email.js';
export * from './session.js';

// Re-export commonly used functions with shorter names for convenience
export {
  // Crypto
  createSignedToken as createToken,
  createAdminToken as adminToken,
  verifySignedToken as verifyToken,
  
  // HTTP
  getBearerToken as bearerToken,
  getCookie as cookie,
  jsonResponse as json,
  errorResponse as error,
  
  // Validation
  isValidEmail as validEmail,
  isValidPhone as validPhone,
  isValidPrice as validPrice,
  sanitizeString as sanitize,
  
  // Database
  logAction as auditLog,
  checkRateLimit as rateLimit,
  recordRateLimit as recordRate,
  
  // CSRF
  generateCSRFToken as csrfToken,
  validateCSRFToken as verifyCsrf
} from './crypto.js';

export {
  getBearerToken,
  getCookie,
  cookieHeader,
  clearCookieHeader,
  getClientIP,
  corsHeaders,
  enforceHttps,
  jsonResponse,
  errorResponse,
  parseJSONSafely,
  getCSRFToken,
  MAX_BODY_SIZE
} from './http.js';

export {
  cleanWhatsapp,
  sanitizeString,
  isValidEmail,
  isValidPhone,
  isValidPrice,
  sanitizeDescription,
  validateBankCode,
  sanitizeArray,
  getValidChipBankCodes
} from './validation.js';

export {
  ensureRateLimitTable,
  checkRateLimit,
  recordRateLimit,
  logAction,
  incrementSessionVersion,
  incrementOwnerSessionVersion,
  getOwnerHomestayIdsFresh,
  recordCheckinAttempt,
  getRecentCheckinAttempts,
  clearCheckinAttempts,
  invalidateOwnerSessionsForHomestay,
  invalidateOwnerSessionsForOwner,
  invalidateOwnerSessions,
  withLock
} from './database.js';

export {
  generateCSRFToken,
  validateCSRFToken
} from './csrf.js';

export {
  sendHostPayoutEmail,
  sendPayoutRecordEmail
} from './email.js';
