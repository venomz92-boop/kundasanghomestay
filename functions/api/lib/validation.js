// /functions/api/lib/validation.js
// Input validation and sanitization utilities

const VALID_CHIP_SEND_CODES = new Set([
  'ACDBMYK2','PHBMMYKL','AGOBMYKL','RJHIMYKL','MFBBMYKL','ARBKMYKL',
  'BIMBMYKL','BKRMMYKL','BMMBMYKL','BOFAMY2X','BKCHMYKL','BOTKMYKX',
  'BSNAMYK1','BNPAMYKL','PCBCMYKL','CIBBMYKL','DEUTMYKL','FNXSMYNB',
  'GXSPMYKL','HLBBMYKL','HBMBMYKL','ICBKMYKL','CHASMYKX','KFHOMYKL',
  'MBBEMYKL','AFBQMYKL','MHCBMYKA','OCBCMYKL','PBBEMYKL','RHBBMYKL',
  'SCBLMYKX','SMBCMYKL','TNGDMYNB','UOVBMYKL'
]);

/**
 * Clean whatsapp number to digits only
 * @param {string} value 
 * @returns {string}
 */
export function cleanWhatsapp(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

/**
 * Sanitize string with max length
 * @param {string} str 
 * @param {number} maxLen 
 * @returns {string}
 */
export function sanitizeString(str, maxLen = 200) {
  if (!str) return '';
  return String(str).slice(0, maxLen).trim();
}

/**
 * Validate email format
 * @param {string} email 
 * @returns {boolean}
 */
export function isValidEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).toLowerCase());
}

/**
 * Validate phone number (Malaysia format)
 * @param {string} phone 
 * @returns {boolean}
 */
export function isValidPhone(phone) {
  if (!phone) return false;
  const cleaned = cleanWhatsapp(phone);
  return /^6?01[0-9]{8,9}$/.test(cleaned);
}

/**
 * Validate price is positive number
 * @param {number|string} price 
 * @returns {boolean}
 */
export function isValidPrice(price) {
  const num = Number(price);
  return Number.isFinite(num) && num > 0;
}

/**
 * Sanitize description (allow basic HTML)
 * @param {string} desc 
 * @returns {string}
 */
export function sanitizeDescription(desc) {
  if (!desc) return '';
  // Allow basic formatting tags, strip everything else
  const allowed = ['b', 'i', 'u', 'br', 'p', 'ul', 'ol', 'li'];
  let sanitized = String(desc);
  // Remove disallowed tags
  sanitized = sanitized.replace(/<(?!\/?(?:b|i|u|br|p|ul|ol|li)[^>]*>)/gi, '&lt;');
  return sanitized.slice(0, 5000);
}

/**
 * Validate bank code against CHIP whitelist
 * @param {string} code 
 * @returns {boolean}
 */
export function validateBankCode(code) {
  if (!code) return false;
  return VALID_CHIP_SEND_CODES.has(String(code).toUpperCase());
}

/**
 * Sanitize array with max items and item limit
 * @param {Array} arr 
 * @param {number} maxItems 
 * @returns {Array}
 */
export function sanitizeArray(arr, maxItems = 20) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxItems).map(item => {
    if (typeof item === 'string') return sanitizeString(item, 500);
    return item;
  });
}

/**
 * Get list of valid CHIP bank codes
 * @returns {Array<string>}
 */
export function getValidChipBankCodes() {
  return [...VALID_CHIP_SEND_CODES];
}
