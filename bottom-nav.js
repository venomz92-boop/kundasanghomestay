(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. Keep the bottom bar and the slide-out menu from colliding.
   *
   * The bar is fixed to the bottom of the screen. On shorter phones the
   * open menu reaches down far enough to cover it - on a 568px screen it
   * hides the Logout button. The existing bn-hidden rule never fired
   * because the menu button binds window.toggleMobileMenu directly, so
   * swapping that function later has no effect on the listener.
   * Watching the menu's own class avoids depending on call order.
   * ------------------------------------------------------------------ */
  function syncBar() {
    var menu = document.getElementById('mobileNav');
    var bar = document.getElementById('mobileBottomNav');
    if (!menu || !bar) return;
    document.body.classList.toggle('bn-hidden', menu.classList.contains('open'));
  }
  window.__kdSyncBar = syncBar;

  function watchMenu() {
    var menu = document.getElementById('mobileNav');
    if (!menu) return;
    if (window.MutationObserver) {
      if (menu.__kdWatched) return;
      menu.__kdWatched = true;
      new MutationObserver(syncBar).observe(menu, { attributes: true, attributeFilter: ['class'] });
    }
    // Fallback for old browsers: catch the tap on the button itself.
    var btn = document.getElementById('mobileMenuBtn');
    if (btn && !btn.__kdWatched) {
      btn.__kdWatched = true;
      btn.addEventListener('click', function () { setTimeout(syncBar, 0); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchMenu);
  } else {
    watchMenu();
  }
  setTimeout(syncBar, 0);

  /* ------------------------------------------------------------------
   * 2. Give this page a bottom nav, unless it already has one.
   * ------------------------------------------------------------------ */
  if (document.getElementById('mobileBottomNav')) return;

  var CSS = [
    '.bn-item{flex:1 1 0%;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 0 7px;text-decoration:none;-webkit-tap-highlight-color:transparent}',
    '.bn-icon-wrap{width:58px;height:32px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:rgba(33,33,33,.55);transition:background .25s ease,color .25s ease}',
    '.bn-item:active .bn-icon-wrap{background:rgba(15,56,46,.10)}',
    '.bn-item svg{width:21px;height:21px}',
    ".bn-label{font-family:'Poppins',sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.2px;color:rgba(33,33,33,.55);transition:color .2s ease}",
    '.bn-item.bn-active .bn-icon-wrap{background:#0F382E;color:#fff}',
    '.bn-item.bn-active .bn-label{color:#0F382E;font-weight:700}',
    'body.bn-hidden #mobileBottomNav{display:none}',
    '@media (max-width:1023.98px){body{padding-bottom:calc(74px + env(safe-area-inset-bottom,0px))}}'
  ].join('\n');
  var st = document.createElement('style');
  st.id = 'kd-bottomnav-css';
  st.textContent = CSS;
  document.head.appendChild(st);

  var ICO = {
    home:'<path d="M3 10.8 12 3l9 7.8"/><path d="M5.4 9.6V21h4.8v-6.2h3.6V21h4.8V9.6"/>',
    explore:'<circle cx="12" cy="12" r="8.6"/><path d="M14.9 9.1l-1.7 4.2-4.2 1.7 1.7-4.2z"/>',
    stays:'<path d="M2 19v-7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v7"/><path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M12 4v6"/><path d="M2 17h20"/>',
    bookings:'<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10.5h17"/>',
    account:'<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5c0-3.9 3.4-6 7.5-6s7.5 2.1 7.5 6"/>'
  };
  function item(href, key, label, icon) {
    return '<a href="' + href + '" class="bn-item" data-nav-for="' + key + '">' +
      '<span class="bn-icon-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg></span>' +
      '<span class="bn-label">' + label + '</span></a>';
  }

  var nav = document.createElement('nav');
  nav.id = 'mobileBottomNav';
  nav.className = 'lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-black/5 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]';
  nav.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
  nav.setAttribute('aria-label', 'Mobile bottom navigation');
  nav.innerHTML = '<div class="flex items-stretch">' +
    item('/', 'home', 'Home', ICO.home) +
    item('/explore.html', 'explore', 'Explore', ICO.explore) +
    item('/#homePage', 'stays', 'Stays', ICO.stays) +
    item('/mybookings.html', 'bookings', 'Bookings', ICO.bookings) +
    item('/mybookings.html', 'account', 'Sign In', ICO.account) +
    '</div>';
  document.body.appendChild(nav);

  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  function isHome() { return path === '/' || path === '/index.html' || path === '/index1.html'; }
  function isActive(t) {
    if (t === 'home') return isHome();
    if (t === 'explore') return path === '/explore.html';
    if (t === 'bookings') return path === '/mybookings.html';
    if (t === 'account') return path === '/login.html' || path === '/register.html';
    return false;
  }
  nav.querySelectorAll('.bn-item').forEach(function (el) {
    if (isActive(el.getAttribute('data-nav-for'))) el.classList.add('bn-active');
  });

  var stays = nav.querySelector('[data-nav-for="stays"]');
  if (stays) stays.addEventListener('click', function (e) {
    if (isHome()) {
      e.preventDefault();
      var t = document.getElementById('homePage');
      if (t) t.scrollIntoView({ behavior: 'smooth' });
    }
  });

  var guest = null;
  try {
    if (window.GuestSession && window.GuestSession.isGuestSessionValid()) guest = window.GuestSession.readGuest();
  } catch (e) {}
  var acc = nav.querySelector('[data-nav-for="account"]');
  if (acc) {
    var lbl = acc.querySelector('.bn-label');
    if (guest && guest.id) {
      if (lbl) lbl.textContent = 'Account';
      acc.setAttribute('href', '/mybookings.html');
    } else {
      if (lbl) lbl.textContent = 'Sign In';
      acc.setAttribute('href', '/login.html');
    }
  }

  watchMenu();
  setTimeout(syncBar, 0);
})();
