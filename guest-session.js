// /guest-session.js – Shared guest session helper (TTL aware)
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
        atob(s)
          .split('')
          .map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join('')
      );
    } catch (e) {
      return '';
    }
  }

  function getTokenExp(token) {
    if (!token || typeof token !== 'string') return 0;
    var firstDot = token.indexOf('.');
    if (firstDot <= 0) return 0;
    try {
      var payload = JSON.parse(b64urlDecode(token.slice(0, firstDot)));
      return Number(payload && payload.exp) || 0;
    } catch (e) {
      return 0;
    }
  }

  function readGuest() {
    try {
      var raw = localStorage.getItem(GUEST_KEY);
      if (!raw) return null;
      var g = JSON.parse(raw);
      return g && g.id ? g : null;
    } catch (e) {
      return null;
    }
  }

  function isGuestSessionValid() {
    var token = localStorage.getItem(TOKEN_KEY);
    var guest = readGuest();
    if (!token || !guest) return false;
    var exp = getTokenExp(token);
    if (!exp || Date.now() >= exp) return false;
    return true;
  }

  function clearGuestSession() {
    try {
      localStorage.removeItem(GUEST_KEY);
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(CSRF_KEY);
      localStorage.removeItem('kd_guest_pending_payment');
      localStorage.removeItem('kd_pending_booking');
    } catch (e) {}
  }

  async function logoutGuest(skipConfirm) {
    if (!skipConfirm) {
      var ok = window.confirm('Are you sure you want to logout?');
      if (!ok) return;
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
    } catch (e) {
      // ignore network error – still clear local state
    }

    clearGuestSession();

    if (typeof window.renderGuestNav === 'function') {
      try { window.renderGuestNav(); } catch (e) {}
    }
    window.location.href = '/';
  }

  async function apiFetch(url, options) {
    options = options || {};
    options.credentials = options.credentials || 'include';
    var res = await fetch(url, options);
    if (res.status === 401) {
      clearGuestSession();
      if (typeof window.renderGuestNav === 'function') {
        try { window.renderGuestNav(); } catch (e) {}
      }
      var path = String(window.location.pathname || '');
      if (path.indexOf('/login.html') === -1 && path.indexOf('/register.html') === -1) {
        window.location.href = '/login.html?expired=1';
      }
      throw new Error('Session expired');
    }
    return res;
  }

  var watcherStarted = false;
  function startExpiryWatcher(onExpire) {
    if (watcherStarted) return;
    watcherStarted = true;
    setInterval(function () {
      var had = !!readGuest();
      if (!isGuestSessionValid()) {
        clearGuestSession();
        if (had && typeof window.renderGuestNav === 'function') {
          try { window.renderGuestNav(); } catch (e) {}
        }
        if (had && typeof onExpire === 'function') {
          try { onExpire(); } catch (e) {}
        }
      }
    }, 60000);
  }

  window.GuestSession = {
    isGuestSessionValid: isGuestSessionValid,
    clearGuestSession: clearGuestSession,
    logoutGuest: logoutGuest,
    apiFetch: apiFetch,
    getTokenExp: getTokenExp,
    startExpiryWatcher: startExpiryWatcher
  };
})();
