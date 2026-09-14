// /csrf-auto.js — Auto-injects X-CSRF-Token on every mutating /api/* request.
//
// WHY THIS EXISTS:
// The /api/_middleware.js CSRF gate rejects any POST/PUT/DELETE/PATCH to
// /api/* that does not carry a valid X-CSRF-Token header. About a dozen
// fetch() call sites across the frontend were written before that gate
// existed and never send the header, so they would all fail with
// 403 CSRF_MISSING the moment the gate went live.
//
// Rather than edit a dozen call sites across four huge HTML files — which
// is exactly where new bugs get introduced — this script patches
// window.fetch once. Every mutating /api/* request from the page will
// automatically carry the correct token, including the ones you haven't
// written yet.
//
// HOW IT PICKS THE TOKEN:
//   - Owner pages: uses kd_owner_csrf_token
//   - Guest pages: uses kd_guest_csrf_token, falls back to kd_csrf_token
// If no token exists in localStorage, it fetches one from
// /api/csrf-token (a GET, so no CSRF needed) and caches it.
//
// INSTALL:
// Add this line to the <head> of every page that talks to /api/*,
// AFTER the guest-session.js include:
//   <script src="/csrf-auto.js"></script>
//
// SAFE TO INCLUDE ON EVERY PAGE. Idempotent. No external dependencies.
//
// Generated for Kundasang Homestay.
(function () {
  'use strict';

  if (window.__kdCsrfFetchPatched) return;
  window.__kdCsrfFetchPatched = true;

  var originalFetch = window.fetch.bind(window);
  var CSRF_REFRESH_LOCK = null;

  // Which session type should we default to on this page?
  function defaultType() {
    var path = String(window.location.pathname || '');
    if (path.indexOf('/owner') === 0) return 'owner';
    if (path.indexOf('/list') === 0) return 'owner';
    return 'guest';
  }

  function readToken() {
    var type = defaultType();
    try {
      if (type === 'owner') {
        var o = localStorage.getItem('kd_owner_csrf_token');
        if (o) return o;
      }
      var g = localStorage.getItem('kd_guest_csrf_token');
      if (g) return g;
      var shared = localStorage.getItem('kd_csrf_token');
      if (shared) return shared;
      var o2 = localStorage.getItem('kd_owner_csrf_token');
      if (o2) return o2;
    } catch (e) {}
    return null;
  }

  function storeToken(type, token) {
    try {
      localStorage.setItem('kd_' + type + '_csrf_token', token);
      if (type === 'guest') {
        // Keep the shared key in sync for pages that read it directly.
        localStorage.setItem('kd_csrf_token', token);
      }
    } catch (e) {}
  }

  function fetchFreshToken(type) {
    // Dedupe concurrent refreshes.
    if (CSRF_REFRESH_LOCK) return CSRF_REFRESH_LOCK;

    CSRF_REFRESH_LOCK = originalFetch(
      '/api/csrf-token?type=' + encodeURIComponent(type),
      { method: 'GET', credentials: 'include', cache: 'no-store' }
    )
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        if (data && data.token) {
          storeToken(type, data.token);
          return data.token;
        }
        return null;
      })
      .catch(function () { return null; })
      .finally(function () { CSRF_REFRESH_LOCK = null; });

    return CSRF_REFRESH_LOCK;
  }

  function isMutatingApiCall(url, method) {
    var m = String(method || 'GET').toUpperCase();
    if (m !== 'POST' && m !== 'PUT' && m !== 'DELETE' && m !== 'PATCH') return false;

    var pathname = '';
    try {
      pathname = new URL(url, window.location.origin).pathname;
    } catch (e) {
      pathname = String(url || '');
    }
    return pathname.indexOf('/api/') === 0;
  }

  window.fetch = async function (input, init) {
    var url;
    var method;

    try {
      if (typeof input === 'string') {
        url = input;
        method = (init && init.method) || 'GET';
      } else if (input && typeof input === 'object' && 'url' in input) {
        url = input.url;
        method = (init && init.method) || input.method || 'GET';
      } else {
        url = String(input);
        method = (init && init.method) || 'GET';
      }
    } catch (e) {
      return originalFetch(input, init);
    }

    if (!isMutatingApiCall(url, method)) {
      return originalFetch(input, init);
    }

    // Build a merged init that preserves caller's body/mode/etc.
    var newInit = {};
    if (init) {
      for (var k in init) {
        if (Object.prototype.hasOwnProperty.call(init, k)) newInit[k] = init[k];
      }
    }
    if (!('credentials' in newInit)) newInit.credentials = 'include';

    var headers = new Headers(newInit.headers || (input && input.headers) || {});

    if (!headers.has('X-CSRF-Token')) {
      var token = readToken();
      if (!token) {
        token = await fetchFreshToken(defaultType());
      }
      if (token) headers.set('X-CSRF-Token', token);
    }

    newInit.headers = headers;

    var response = await originalFetch(input, newInit);

    // If the server said the token was missing/invalid/expired, clear
    // cache and try exactly once more with a fresh one. This handles the
    // case where the token expired while the page was open.
    if (response && response.status === 403) {
      var retryBody = null;
      try {
        var clone = response.clone();
        retryBody = await clone.json();
      } catch (e) {}

      var needsRetry = retryBody && (
        retryBody.code === 'CSRF_MISSING' ||
        retryBody.code === 'CSRF_INVALID'
      );

      if (needsRetry) {
        var freshToken = await fetchFreshToken(defaultType());
        if (freshToken) {
          var retryHeaders = new Headers(newInit.headers || {});
          retryHeaders.set('X-CSRF-Token', freshToken);
          var retryInit = {};
          for (var k2 in newInit) {
            if (Object.prototype.hasOwnProperty.call(newInit, k2)) retryInit[k2] = newInit[k2];
          }
          retryInit.headers = retryHeaders;
          return originalFetch(input, retryInit);
        }
      }
    }

    return response;
  };

  // Expose manual helpers so pages can call them directly if needed.
  window.KdCsrf = {
    read: readToken,
    refresh: fetchFreshToken,
    defaultType: defaultType
  };
})();
