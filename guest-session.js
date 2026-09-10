/* /guest-session.js — Self-contained guest session manager
 * Handles: TTL expiry, nav rendering, logout (with cookie clear), auto-logout on 401
 * Add: <script src="/guest-session.js"></script>  to <head> of any page with guest nav
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'kd_guest_token';
  var GUEST_KEY = 'kd_guest';
  var CSRF_KEY  = 'kd_csrf_token';

  function b64urlDecode(str) {
    try {
      var s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
      var pad = s.length % 4;
      if (pad) s += '='.repeat(4 - pad);
      return decodeURIComponent(
        atob(s).split('').map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join('')
      );
    } catch (e) { return ''; }
  }

  function getTokenExp(token) {
    if (!token || typeof token !== 'string') return 0;
    var dot = token.indexOf('.');
    if (dot <= 0) return 0;
    try {
      var p = JSON.parse(b64urlDecode(token.slice(0, dot)));
      return Number(p && p.exp) || 0;
    } catch (e) { return 0; }
  }

  function readGuest() {
    try {
      var raw = localStorage.getItem(GUEST_KEY);
      if (!raw) return null;
      var g = JSON.parse(raw);
      return g && g.id ? g : null;
    } catch (e) { return null; }
  }

  function isValid() {
    var token = localStorage.getItem(TOKEN_KEY);
    var guest = readGuest();
    if (!token || !guest) return false;
    var exp = getTokenExp(token);
    if (!exp || Date.now() >= exp) return false;
    return true;
  }

  function clearSession() {
    try {
      localStorage.removeItem(GUEST_KEY);
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(CSRF_KEY);
      localStorage.removeItem('kd_guest_pending_payment');
      localStorage.removeItem('kd_pending_booking');
      localStorage.removeItem('kd_failed_booking');
    } catch (e) {}
  }

  /* ============================================================
   * PRE-CHECK — runs synchronously in <head>, BEFORE page scripts.
   * This prevents the "logged in briefly then logged out" flicker.
   * ============================================================ */
  (function precheck() {
    var token = localStorage.getItem(TOKEN_KEY);
    var guestRaw = localStorage.getItem(GUEST_KEY);
    if (!token || !guestRaw) return;
    var exp = getTokenExp(token);
    if (!exp || Date.now() >= exp) {
      clearSession();
    }
  })();

  /* ============================================================
   * NAV DOM UPDATE — mirrors what each page's renderGuestNav() does
   * but driven by our TTL check.
   * ============================================================ */
  function updateNavDOM() {
    var guest = isValid() ? readGuest() : null;

    var loginNav   = document.getElementById('guestNav');
    var profileNav = document.getElementById('guestProfileNav');
    var mLoginNav  = document.getElementById('mGuestNav');
    var mProfileNav = document.getElementById('mGuestProfileNav');
    var avatar     = document.getElementById('guestAvatar');
    var nameNav    = document.getElementById('guestNameNav');
    var mAvatar    = document.getElementById('mGuestAvatar');
    var mNameNav   = document.getElementById('mGuestNameNav');

  if (guest) {
  if (loginNav) { loginNav.classList.add('hidden'); loginNav.classList.remove('flex'); }
  if (profileNav) { profileNav.classList.remove('hidden'); profileNav.classList.add('flex'); }

  var initial = (guest.name || 'G').charAt(0).toUpperCase();
  var isVerified = guest.verified === true;
  var avatarText = isVerified ? '✓' : initial;

  if (avatar) {
    avatar.innerText = avatarText;
    avatar.className = 'guest-avatar w-7 h-7 text-xs flex items-center justify-center rounded-full font-bold ' +
      (isVerified ? 'bg-emerald-600 text-white' : 'bg-[#D4A373] text-[#0F382E]');
  }
  if (nameNav) nameNav.innerText = guest.name || guest.email || 'Guest';

  if (mLoginNav) { mLoginNav.classList.add('hidden'); mLoginNav.classList.remove('space-y-2', 'space-y-3'); }
  if (mProfileNav) { mProfileNav.classList.remove('hidden'); }

  if (mAvatar) {
    mAvatar.innerText = avatarText;
    mAvatar.className = 'avatar ' + (isVerified ? 'bg-emerald-600 text-white' : 'bg-[#D4A373] text-[#0F382E]');
  }
    if (mNameNav) mNameNav.innerText = guest.name || guest.email || 'Guest';
    } else {
      if (loginNav) { loginNav.classList.remove('hidden'); loginNav.classList.add('flex'); }
      if (profileNav) { profileNav.classList.add('hidden'); profileNav.classList.remove('flex'); }
      if (mLoginNav) { mLoginNav.classList.remove('hidden'); }
      if (mProfileNav) { mProfileNav.classList.add('hidden'); }
    }
  }

  /* ============================================================
   * LOGOUT — clears server cookie AND local storage
   * ============================================================ */
  async function logoutGuest(skipConfirm) {
    if (!skipConfirm) {
      if (!window.confirm('Are you sure you want to logout?')) return;
    }
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': localStorage.getItem(CSRF_KEY) || ''
        },
        credentials: 'include'
      });
    } catch (e) { /* ignore — still clear local */ }

    clearSession();
    updateNavDOM();
    window.location.href = '/';
  }

  /* ============================================================
   * apiFetch — auto-logout on 401
   * ============================================================ */
  async function apiFetch(url, opts) {
    opts = opts || {};
    opts.credentials = opts.credentials || 'include';
    var res = await fetch(url, opts);
    if (res.status === 401) {
      clearSession();
      updateNavDOM();
      var path = String(window.location.pathname || '');
      if (path.indexOf('/login.html') === -1 && path.indexOf('/register.html') === -1) {
        window.location.href = '/login.html?expired=1';
      }
      throw new Error('Session expired');
    }
    return res;
  }

  /* ============================================================
   * WATCHER — polls every 60s, kicks user out on expiry
   * ============================================================ */
  var watcherStarted = false;
  function startExpiryWatcher() {
    if (watcherStarted) return;
    watcherStarted = true;
    setInterval(function () {
      var had = !!readGuest();
      if (had && !isValid()) {
        clearSession();
        updateNavDOM();
        if (typeof window.showAlert === 'function') {
          window.showAlert('Session Expired', 'Your session has expired. Please log in again.');
        } else {
          alert('Your session has expired. Please log in again.');
        }
      }
    }, 60000);
  }

  /* ============================================================
   * AUTO-INIT — runs after page's own inline scripts.
   * Overrides window.logoutGuest and fixes the nav DOM.
   * ============================================================ */
  function init() {
    // Re-clear in case page script re-set something
    if (readGuest() && !isValid()) clearSession();

    updateNavDOM();
    startExpiryWatcher();

    // Override any page-local logoutGuest with our version
    window.logoutGuest = logoutGuest;
  }

  function scheduleInit() {
    // setTimeout(0) ensures page inline scripts (which run on DOMContentLoaded
    // or immediately) have finished defining their own logoutGuest first.
    setTimeout(init, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInit);
  } else {
    scheduleInit();
  }

  /* ============================================================
   * PUBLIC API
   * ============================================================ */
  window.GuestSession = {
    isGuestSessionValid: isValid,
    clearGuestSession:   clearSession,
    logoutGuest:         logoutGuest,
    apiFetch:            apiFetch,
    getTokenExp:         getTokenExp,
    startExpiryWatcher:  startExpiryWatcher,
    updateNavDOM:        updateNavDOM
  };
})();
