/* /guest-session.js — Cookie-based guest session manager.
 *
 * Plain English: after the backend security upgrade, the login token is
 * no longer returned to JavaScript — it lives only in an HttpOnly cookie
 * that the browser sends automatically. This script therefore no longer
 * reads or stores any token. It tracks the guest profile + an expiry
 * timestamp in localStorage purely for UI purposes, and it makes every
 * API call with `credentials: 'include'` so the cookie rides along.
 *
 * Add to <head>: <script src="/guest-session.js"></script>
 *
 * Public API (unchanged):
 *   GuestSession.isGuestSessionValid()
 *   GuestSession.clearGuestSession()
 *   GuestSession.logoutGuest()
 *   GuestSession.apiFetch(url, opts)
 *   GuestSession.updateNavDOM()
 *   GuestSession.startExpiryWatcher()
 *
 * New helper for login pages:
 *   GuestSession.setSession(guest, expiresInSeconds)
 */
(function () {
  'use strict';

  var GUEST_KEY   = 'kd_guest';
  var EXPIRES_KEY = 'kd_guest_expires_at';
  var CSRF_KEY    = 'kd_csrf_token';
  var LEGACY_TOKEN_KEY = 'kd_guest_token';   // cleanup only
  var DEFAULT_TTL_SECONDS = 2 * 60 * 60;

  /* ============================================================
   * STORAGE HELPERS
   * ============================================================ */
  function readGuest() {
    try {
      var raw = localStorage.getItem(GUEST_KEY);
      if (!raw) return null;
      var g = JSON.parse(raw);
      return g && g.id ? g : null;
    } catch (e) { return null; }
  }

  function readExpiresAt() {
    var v = parseInt(localStorage.getItem(EXPIRES_KEY) || '0', 10);
    return isNaN(v) ? 0 : v;
  }

  function setSession(guest, expiresInSeconds) {
    if (!guest || !guest.id) return false;
    var ttl = Number(expiresInSeconds) > 0 ? Number(expiresInSeconds) : DEFAULT_TTL_SECONDS;
    try {
      localStorage.setItem(GUEST_KEY, JSON.stringify(guest));
      localStorage.setItem(EXPIRES_KEY, String(Date.now() + ttl * 1000));
      // Drop any legacy token value left over from the previous version.
      try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch (_) {}
    } catch (e) { return false; }
    return true;
  }

  function isValid() {
    var guest = readGuest();
    if (!guest) return false;
    var exp = readExpiresAt();
    if (!exp || Date.now() >= exp) return false;
    return true;
  }

  function clearSession() {
    try {
      localStorage.removeItem(GUEST_KEY);
      localStorage.removeItem(EXPIRES_KEY);
      localStorage.removeItem(CSRF_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      localStorage.removeItem('kd_guest_pending_payment');
      localStorage.removeItem('kd_pending_booking');
      localStorage.removeItem('kd_failed_booking');
    } catch (e) {}
  }

  /* ============================================================
   * PRE-CHECK — runs synchronously in <head>, BEFORE page scripts.
   * Prevents the "logged in briefly then logged out" flicker.
   * ============================================================ */
  (function precheck() {
    // If a guest record exists but its TTL has expired, wipe it now.
    if (readGuest() && !isValid()) clearSession();
    // Scrub any old token value even if the guest record is still valid.
    try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch (_) {}
  })();

  /* ============================================================
   * NAV DOM UPDATE — mirrors the per-page renderGuestNav()
   * ============================================================ */
  function updateNavDOM() {
    var guest = isValid() ? readGuest() : null;

    var loginNav    = document.getElementById('guestNav');
    var profileNav  = document.getElementById('guestProfileNav');
    var mLoginNav   = document.getElementById('mGuestNav');
    var mProfileNav = document.getElementById('mGuestProfileNav');
    var avatar      = document.getElementById('guestAvatar');
    var nameNav     = document.getElementById('guestNameNav');
    var mAvatar     = document.getElementById('mGuestAvatar');
    var mNameNav    = document.getElementById('mGuestNameNav');

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
   * LOGOUT — server clears cookie, we clear local UI state.
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
   * apiFetch — cookie-only; auto-logout on 401.
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
   * WATCHER — polls every 60s, kicks user out on expiry.
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
   * AUTO-INIT — runs after the page's own inline scripts.
   * Overrides window.logoutGuest so the header button works.
   * ============================================================ */
  function init() {
    if (readGuest() && !isValid()) clearSession();
    updateNavDOM();
    startExpiryWatcher();
    window.logoutGuest = logoutGuest;
  }

  function scheduleInit() {
    // setTimeout(0) so a page's inline script can define its own
    // logoutGuest first; we then override with the cookie-based one.
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
    setSession:          setSession,
    readGuest:           readGuest,
    updateNavDOM:        updateNavDOM,
    startExpiryWatcher:  startExpiryWatcher
  };
})();
