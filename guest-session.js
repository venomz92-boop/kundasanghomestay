/* /guest-session.js — BROWSER FILE (main folder, next to index.html).
 * Plain English: "logged in" = we have your guest record saved.
 * The server is the real judge of whether the cookie is valid.
 *
 * [THIS REVISION]
 * The logout confirmation now uses the page's styled showConfirm()
 * modal when it's available, so the dialog matches the site's design
 * instead of showing the browser's native confirm(). If the page
 * doesn't define showConfirm() (e.g. login.html, register.html,
 * explore.html), it falls back to the native dialog so the logout
 * button still works everywhere.
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

  /* ============================================================
   * Confirmation helper.
   *
   * Prefers the page's styled showConfirm() when present. Some
   * pages (login.html, register.html, explore.html) don't define
   * one — they fall back to the native browser confirm() so the
   * logout button still works there.
   *
   * Always resolves to a plain boolean. Never throws.
   * ============================================================ */
  function confirmLogout() {
    var title = 'Logout';
    var message = 'Are you sure you want to logout?';

    if (typeof window.showConfirm === 'function') {
      try {
        var result = window.showConfirm(title, message);
        if (result && typeof result.then === 'function') {
          return result
            .then(function (v) { return v === true; })
            .catch(function () { return window.confirm(message); });
        }
        return Promise.resolve(result === true);
      } catch (e) {
        return Promise.resolve(window.confirm(message));
      }
    }

    return Promise.resolve(window.confirm(message));
  }

  async function logoutGuest(skipConfirm) {
    if (!skipConfirm) {
      var ok = await confirmLogout();
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

  /* ============================================================
   * MOBILE ACCOUNT SHEET
   * Tapping the bottom-nav "Account" tab while signed in opens a
   * bottom sheet: the guest's profile, shortcuts and account
   * actions. Self-contained - builds itself only on pages that
   * actually have that tab, so pages without a bottom nav pay
   * nothing. Signed-out guests are left alone: their tab still
   * just goes to the login page.
   * ============================================================ */
  var SHEET_ID = 'kdas-root';

  var SHEET_CSS = [
    '#kdas-root{position:fixed;inset:0;z-index:2147483000;display:none}',
    '#kdas-root.kdas-open{display:block}',
    '#kdas-root .kdas-scrim{position:absolute;inset:0;background:rgba(16,20,18,.45);opacity:0;transition:opacity .25s ease}',
    '#kdas-root.kdas-in .kdas-scrim{opacity:1}',
    '#kdas-root .kdas-panel{position:absolute;left:0;right:0;bottom:0;background:#fff;border-radius:22px 22px 0 0;',
    'padding:10px 16px calc(14px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 34px rgba(0,0,0,.18);',
    "font-family:'Poppins',system-ui,-apple-system,sans-serif;transform:translateY(100%);",
    'transition:transform .28s cubic-bezier(.22,.7,.3,1);max-height:88vh;overflow-y:auto;box-sizing:border-box}',
    '#kdas-root.kdas-in .kdas-panel{transform:translateY(0)}',
    '#kdas-root .kdas-grab{width:42px;height:4px;border-radius:99px;background:#e4e4e7;margin:2px auto 14px}',
    '#kdas-root .kdas-id{display:flex;align-items:center;gap:12px;padding:0 2px 14px;border-bottom:1px solid #f0f0f0}',
    '#kdas-root .kdas-av{width:48px;height:48px;border-radius:99px;background:#D4A373;color:#0F382E;display:flex;',
    'align-items:center;justify-content:center;font-weight:800;font-size:19px;flex:0 0 auto}',
    '#kdas-root .kdas-av.kdas-ver{background:#0F382E;color:#fff}',
    '#kdas-root .kdas-who{min-width:0;flex:1 1 auto}',
    '#kdas-root .kdas-nm{font-weight:700;font-size:16px;color:#212121;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#kdas-root .kdas-em{font-size:12px;color:#8b8b93;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#kdas-root .kdas-vfb{display:inline-block;margin-top:5px;font-size:10px;font-weight:700;letter-spacing:.04em;',
    'text-transform:uppercase;color:#166534;background:#dcfce7;border:1px solid #bbf7d0;border-radius:99px;padding:2px 8px}',
    '#kdas-root .kdas-x{width:34px;height:34px;border-radius:99px;border:1px solid #ececec;background:#fafafa;color:#71717a;',
    'font-size:13px;cursor:pointer;flex:0 0 auto;padding:0;line-height:1}',
    '#kdas-root .kdas-menu{padding:6px 0 0}',
    '#kdas-root .kdas-row{display:flex;align-items:center;gap:12px;width:100%;background:none;border:0;border-radius:14px;',
    'padding:14px 10px;font-family:inherit;font-weight:600;font-size:14.5px;color:#212121;text-align:left;',
    'cursor:pointer;text-decoration:none;transition:background .15s;box-sizing:border-box}',
    '#kdas-root .kdas-row:active{background:#f6f6f6}',
    '#kdas-root .kdas-ico{font-size:17px;width:24px;text-align:center;flex:0 0 auto}',
    '#kdas-root .kdas-lbl{flex:1 1 auto;min-width:0}',
    '#kdas-root .kdas-chev{color:#c4c4cc;font-size:17px;flex:0 0 auto}',
    '#kdas-root .kdas-zone{margin-top:6px;padding-top:8px;border-top:1px solid #f0f0f0}',
    '#kdas-root .kdas-danger{color:#dc2626}',
    '#kdas-root .kdas-danger:active{background:#fef2f2}',
    '#kdas-root .kdas-note{font-size:11px;color:#a1a1aa;line-height:1.5;padding:0 10px 2px;margin:0}',
    'body.kdas-locked{overflow:hidden}'
  ].join('\n');

  function buildSheet() {
    if (document.getElementById(SHEET_ID)) return;
    if (!document.getElementById('kdas-css')) {
      var st = document.createElement('style');
      st.id = 'kdas-css';
      st.textContent = SHEET_CSS;
      document.head.appendChild(st);
    }
    var root = document.createElement('div');
    root.id = SHEET_ID;
    root.innerHTML = [
      '<div class="kdas-scrim" data-kdas-close></div>',
      '<div class="kdas-panel" role="dialog" aria-modal="true" aria-labelledby="kdas-name">',
        '<div class="kdas-grab"></div>',
        '<div class="kdas-id">',
          '<div class="kdas-av" id="kdas-av"></div>',
          '<div class="kdas-who">',
            '<div class="kdas-nm" id="kdas-name"></div>',
            '<div class="kdas-em" id="kdas-mail"></div>',
            '<span class="kdas-vfb" id="kdas-ver" style="display:none">Verified Guest</span>',
          '</div>',
          '<button class="kdas-x" id="kdas-close" aria-label="Close" type="button">&#10005;</button>',
        '</div>',
        '<div class="kdas-menu">',
          '<a class="kdas-row" href="/mybookings.html"><span class="kdas-ico">&#128197;</span><span class="kdas-lbl">My Bookings</span><span class="kdas-chev">&#8250;</span></a>',
          '<a class="kdas-row" href="/forgot-password.html"><span class="kdas-ico">&#128273;</span><span class="kdas-lbl">Reset Password</span><span class="kdas-chev">&#8250;</span></a>',
          '<button class="kdas-row" id="kdas-logout" type="button"><span class="kdas-ico">&#128682;</span><span class="kdas-lbl">Logout</span></button>',
        '</div>',
        '<div class="kdas-zone">',
          '<button class="kdas-row kdas-danger" id="kdas-delete" type="button"><span class="kdas-ico">&#128465;</span><span class="kdas-lbl">Delete Account</span></button>',
          '<p class="kdas-note">Permanently removes your account and personal details.</p>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(root);

    root.querySelector('[data-kdas-close]').addEventListener('click', closeSheet);
    document.getElementById('kdas-close').addEventListener('click', closeSheet);
    document.getElementById('kdas-logout').addEventListener('click', function () { closeSheet(); logoutGuest(); });
    document.getElementById('kdas-delete').addEventListener('click', function () {
      closeSheet();
      var b = document.getElementById('bookingsView');
      if (typeof window.openDeleteAccountModal === 'function' && b && !b.classList.contains('hidden')) {
        setTimeout(function () { window.openDeleteAccountModal(); }, 260);
      } else {
        setTimeout(function () { window.location.href = '/mybookings.html?account=delete'; }, 120);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') closeSheet();
    });
  }

  function fillSheet() {
    var g = (isValid() && readGuest()) || {};
    var name = g.name || g.email || 'Guest';
    var verified = g.verified === true;
    var av = document.getElementById('kdas-av');
    if (av) {
      av.textContent = verified ? '\u2713' : String(name).charAt(0).toUpperCase();
      av.className = 'kdas-av' + (verified ? ' kdas-ver' : '');
    }
    var nm = document.getElementById('kdas-name');
    var em = document.getElementById('kdas-mail');
    if (nm) nm.textContent = name;
    if (em) em.textContent = g.email || '';
    var vb = document.getElementById('kdas-ver');
    if (vb) vb.style.display = (verified && g.email) ? 'inline-block' : 'none';
  }

  function openSheet() {
    buildSheet();
    fillSheet();
    var root = document.getElementById(SHEET_ID);
    root.classList.add('kdas-open');
    void root.offsetWidth;
    root.classList.add('kdas-in');
    document.body.classList.add('kdas-locked');
    var x = document.getElementById('kdas-close');
    if (x) { try { x.focus({ preventScroll: true }); } catch (e) {} }
  }

  function closeSheet() {
    var root = document.getElementById(SHEET_ID);
    if (!root || !root.classList.contains('kdas-open')) return;
    root.classList.remove('kdas-in');
    document.body.classList.remove('kdas-locked');
    setTimeout(function () { root.classList.remove('kdas-open'); }, 260);
  }

  function wireAccountTab() {
    var tab = document.querySelector('[data-nav-for="account"]');
    if (!tab || tab.getAttribute('data-kdas-wired') === '1') return;
    tab.setAttribute('data-kdas-wired', '1');
    tab.addEventListener('click', function (e) {
      if (!isValid()) return;
      e.preventDefault();
      openSheet();
    });
  }
  
    function init() {
    updateNavDOM();
    wireAccountTab();
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
