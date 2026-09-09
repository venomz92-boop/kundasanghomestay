// ===== auth.js =====
const API_BASE = "/api";
const SESSION_KEYS = {
  GUEST_TOKEN: 'kd_guest_token',
  GUEST_PROFILE: 'kd_guest',
  CSRF_TOKEN: 'kd_csrf_token',
  OWNER_TOKEN: 'kd_owner_token',
  ADMIN_TOKEN: 'kd_admin_token'
};

function getGuestToken() { return localStorage.getItem(SESSION_KEYS.GUEST_TOKEN); }
function getOwnerToken() { return sessionStorage.getItem(SESSION_KEYS.OWNER_TOKEN); }
function getAdminToken() { return sessionStorage.getItem(SESSION_KEYS.ADMIN_TOKEN); }
function getCsrfToken() { return localStorage.getItem(SESSION_KEYS.CSRF_TOKEN); }

function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]));
  } catch { return null; }
}

function isTokenExpired(token) {
  const payload = decodeJWT(token);
  if (!payload || !payload.exp) return true;
  return Date.now() > (payload.exp * 1000 - 300 * 1000);
}

function clearAllSessions() {
  Object.values(SESSION_KEYS).forEach(key => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  });
}

async function authenticatedFetch(url, options = {}) {
  const token = getGuestToken() || getOwnerToken() || getAdminToken();
  const csrf = getCsrfToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (csrf) headers['X-CSRF-Token'] = csrf;

  const response = await fetch(url, { ...options, headers, credentials: 'include' });
  if (response.status === 401) {
    clearAllSessions();
    window.location.href = '/login.html?return_to=' + encodeURIComponent(window.location.pathname);
    throw new Error('Unauthorized');
  }
  return response;
}
