/* /guest-session.js — BROWSER FILE (main folder, next to index.html).
 * Plain English: "logged in" = we have your guest record saved.
 * The server is the real judge of whether the cookie is valid.
 */
(function () {
  'use strict';

  var GUEST_KEY = 'kd_guest';
  var CSRF_KEY  = 'kd_csrf_token';

  function readGuest() {
    try {
      var raw = localStorage.getItem(GUEST_KEY);
      if (!raw) return null;
      var g = JSON.parse(raw);
      if (Array.isArray(g)) g = g.length > 0 ? g[g.length - 1] : null;
      if (!g) return null;
      if (g.id || g.email) return g;
      return null;
    } catch (e) { return null; }
  }

  function isValid() { return !!readGuest(); }

  function setSession(guest) {
    if (!guest || !guest.id) return false;
    try {
      localStorage.setItem(GUEST_KEY, JSON.stringify(guest));
      try { localStorage.removeItem('kd_guest_token'); } catch (e) {}
      try { localStorage.removeItem('kd_guest_expires_at'); } catch (e) {}
    } catch (e) { return false; }
    return true;
  }

  function clearSession() {
    try {
      localStorage.removeItem(GUEST_KEY);
      localStorage.removeItem(CSRF_KEY);
      localStorage.removeItem('kd_guest_token');
      localStorage.removeItem('kd_guest_expires_at');
      localStorage.removeItem('kd_guest_pending_payment');
      localStorage.removeItem('kd_pending_booking');
      localStorage.removeItem('kd_failed_booking');
      localStorage.removeItem('kd_guest_csrf_token');
    } catch (e) {}
  }

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
    } catch (e) {}
    clearSession();
    updateNavDOM();
    window.location.href = '/';
  }

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

  function startExpiryWatcher() { /* server is the source of truth */ }

  function init() {
    updateNavDOM();
    window.logoutGuest = logoutGuest;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); });
  } else {
    setTimeout(init, 0);
  }

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
