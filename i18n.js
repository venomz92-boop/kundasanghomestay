/* ============================================================================
   i18n.js — Kundasang Homestay bilingual engine (English / Bahasa Malaysia)
   ----------------------------------------------------------------------------
   HOW IT WORKS
     * The page always ships in English, exactly as it does today. No markup
       changes are required anywhere.
     * This script walks the rendered DOM and swaps any text that appears in
       the BM dictionary below. The key is the exact English source string.
     * It also handles document.title, plus placeholder / title / aria-label.
     * A MutationObserver re-translates content rendered later via innerHTML
       (booking lists, modals, dashboards). This matters here, because most of
       this site is JS-rendered after load.
     * Switching language saves the choice and reloads with ?lang=. Reloading
       means we always translate from a fresh English DOM, so there is no
       "already translated" state to get wrong.

   COST: none. No API, no subscription, no third party.
   ============================================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'kd_lang';
  var SUPPORTED = ['en', 'bm'];

  /* ==================================================================== *
   * BAHASA MALAYSIA DICTIONARY
   * --------------------------------------------------------------------
   * Key   = the exact English string as it appears in the DOM.
   * Value = the Bahasa Malaysia rendering.
   *
   * Written in standard Malaysian BM:
   *   - Malaysian spelling throughout (kerana, wang, kad, akaun, baharu)
   *   - "boleh" for can/may (never "bisa", which means poison in Malay)
   *   - "percuma" for free (never Indonesian "gratis")
   *   - "e-mel" for email, "pautan" for link, "laman web" for website
   *   - full diacritic-free Rumi spelling as used in Malaysian publishing
   *
   * Deliberately NOT translated:
   *   - Brand and proper nouns (Kundasang, Kinabalu, Ranau, Mesilau,
   *     Bundu Tuhan, NICK'S CREATIONS, CHIP, FPX, WhatsApp, Facebook)
   *   - Technical tokens that Malaysians use in English (FPX, SSL, WhatsApp)
   *   - The business licence number
   *
   * Omit any string you want to leave in English. An unmapped string simply
   * renders in English — so a partial dictionary degrades gracefully and can
   * be grown page by page.
   * ==================================================================== */
  var BM = {

    /* ---------------- Shared header ---------------- */
    "Home": "Utama",
    "Explore": "Jelajah",
    "Explore Kundasang": "Jelajah Kundasang",
    "About Us": "Tentang Kami",
    "Sign In": "Log Masuk",
    "Register": "Daftar",
    "My Bookings": "Tempahan Saya",
    "Logout": "Log Keluar",
    "List Property": "Senaraikan Homestay",
    "List Your Homestay": "Senaraikan Homestay Anda",
    "🔑 Host Login": "🔑 Log Masuk Pengusaha",
    "Stay • Connect • Belong": "Menginap • Berhubung • Bersama",
    "Skip to main content": "Langkau ke kandungan utama",
    "Stays": "Penginapan",
    "Bookings": "Tempahan",
    "Account": "Akaun",
    "Discover": "Temui",
    "For Hosts": "Untuk Pengusaha",
    "Earn from your property": "Jana pendapatan daripada homestay anda",
    "Create Account": "Buat Akaun",
    "Guest": "Tetamu",
    "Guest Account": "Akaun Tetamu",
    "Host Account": "Akaun Pengusaha",
    "🏠 Home": "🏠 Utama",
    "🗺️ Explore Kundasang": "🗺️ Jelajah Kundasang",
    "ℹ️ About Us": "ℹ️ Tentang Kami",
    "📅 My Bookings": "📅 Tempahan Saya",

    /* ---------------- Shared footer ---------------- */
    "Made for Travelers by Locals — Kundasang edition. Handpicked mountain homestays with Kinabalu soul.":
      "Untuk Pelancong, oleh Penduduk Tempatan — edisi Kundasang. Homestay gunung pilihan dengan jiwa Kinabalu.",
    "Company:": "Syarikat:",
    "Business License:": "Lesen Perniagaan:",
    "Quick Links": "Pautan Pantas",
    "Browse Homestays": "Layari Homestay",
    "Host Registration": "Pendaftaran Pengusaha",
    "Terms & Conditions": "Terma & Syarat",
    "Privacy Policy": "Dasar Privasi",
    "Booking Policy": "Dasar Tempahan",
    "Cancellation & Refund": "Pembatalan & Bayaran Balik",
    "Payment Disclaimer": "Penafian Pembayaran",
    "Cookie Policy": "Dasar Kuki",
    "Facebook Page": "Halaman Facebook",
    "Trust & Safety": "Kepercayaan & Keselamatan",
    "✓ Host Physical Verification": "✓ Pengesahan Fizikal Pengusaha",
    "✓ CHIP FPX Online Protection": "✓ Perlindungan Dalam Talian CHIP FPX",
    "✓ Verified Host Policy": "✓ Dasar Pengusaha Disahkan",
    "✓ Anti-Scam Booking Guarantee": "✓ Jaminan Tempahan Anti-Scam",
    "CHIP FPX Payment Protection": "Perlindungan Pembayaran CHIP FPX",
    "Anti-Scam Booking Guarantee": "Jaminan Tempahan Anti-Scam",
    "We personally visit and verify every homestay before it appears on this platform.":
      "Kami sendiri melawat dan mengesahkan setiap homestay sebelum ia dipaparkan di platform ini.",
    "Kundasang Weather": "Cuaca Kundasang",
    "Loading live weather…": "Memuatkan cuaca langsung…",
    "© 2026 Kundasang Homestay. All rights reserved.":
      "© 2026 Kundasang Homestay. Hak cipta terpelihara.",
    "Verified homestays in Kundasang and Ranau, Sabah. Book direct with local hosts.":
      "Homestay disahkan di Kundasang dan Ranau, Sabah. Tempah terus dengan pengusaha tempatan.",

    /* ---------------- Login / Register ---------------- */
    "Welcome Back": "Selamat Kembali",
    "Sign in to manage your bookings and account.":
      "Log masuk untuk menguruskan tempahan dan akaun anda.",
    "Email Address *": "Alamat E-mel *",
    "Password *": "Kata Laluan *",
    "Forgot Password?": "Lupa Kata Laluan?",
    "Don't have an account?": "Belum ada akaun?",
    "Register here": "Daftar di sini",
    "🔒 Your data is encrypted and secure": "🔒 Data anda disulitkan dan selamat",
    "Join Us": "Sertai Kami",
    "Sign up to book homestays and track your reservations.":
      "Daftar untuk menempah homestay dan menjejak tempahan anda.",
    "Full Name *": "Nama Penuh *",
    "WhatsApp Number *": "Nombor WhatsApp *",
    "Minimum 8 characters": "Sekurang-kurangnya 8 aksara",
    "Already have an account?": "Sudah ada akaun?",
    "Login here": "Log masuk di sini",
    "🔒 By registering, your bookings will be tracked securely":
      "🔒 Dengan mendaftar, tempahan anda akan dijejak dengan selamat",

    /* ---------------- Forgot password ---------------- */
    "Forgot Password": "Lupa Kata Laluan",
    "Reset Your Account": "Set Semula Akaun Anda",
    "Enter your email and we'll send you a link to reset your password.":
      "Masukkan e-mel anda dan kami akan menghantar pautan untuk set semula kata laluan anda.",
    "Email Address": "Alamat E-mel",
    "Account Type": "Jenis Akaun",
    "Send Reset Link": "Hantar Pautan Set Semula",
    "New Password": "Kata Laluan Baharu",
    "Confirm Password": "Sahkan Kata Laluan",
    "Reset Password": "Set Semula Kata Laluan",
    "Remember your password?": "Ingat kata laluan anda?",
    "Back to Login": "Kembali ke Log Masuk",
    "🔒 Reset links expire in 1 hour for security":
      "🔒 Pautan set semula luput dalam 1 jam demi keselamatan",

    /* ---------------- Homepage (index1) — hero & search ---------------- */
    "Breathe The Mountain Air": "Hirup Udara Gunung",
    "Handpicked Homestays": "Homestay Pilihan",
    "in Kundasang": "di Kundasang",
    "Verified local hosts, cool mountain climates, hot water showers, and secure FPX payments.":
      "Pengusaha tempatan yang disahkan, iklim gunung yang sejuk, pancuran air panas, dan pembayaran FPX yang selamat.",
    "Area / Location": "Kawasan / Lokasi",
    "📍 All Kundasang Areas": "📍 Semua Kawasan Kundasang",
    "Guests": "Tetamu",
    "1 Guest": "1 Tetamu",
    "2 Guests": "2 Tetamu",
    "3 Guests": "3 Tetamu",
    "4 Guests": "4 Tetamu",
    "5 Guests": "5 Tetamu",
    "6+ Guests": "6+ Tetamu",
    "Check-in": "Daftar Masuk",
    "Check-out": "Daftar Keluar",
    "Search": "Cari",

    /* ---------------- Homepage — trust section ---------------- */
    "Stay with Confidence": "Menginap dengan Yakin",
    "Verified Mountain Accommodations": "Penginapan Gunung Disahkan",
    "Book with peace of mind using verified hosts and secure payment gateway.":
      "Tempah dengan tenang menggunakan pengusaha yang disahkan dan gerbang pembayaran yang selamat.",
    "🔒 CHIP FPX Protected": "🔒 Dilindungi CHIP FPX",
    "✅ Accepted: FPX — Malaysian online banking":
      "✅ Diterima: FPX — perbankan dalam talian Malaysia",
    "💳 Coming soon: Credit / Debit Card": "💳 Akan datang: Kad Kredit / Debit",

    /* ---------------- Homepage — how it works ---------------- */
    "Booking Made Simple": "Tempahan Mudah",
    "How It Works": "Cara Ia Berfungsi",
    "Three steps from browsing to check-in. No credit card needed — pay directly from your Malaysian bank account.":
      "Tiga langkah daripada melayari hingga daftar masuk. Tiada kad kredit diperlukan — bayar terus daripada akaun bank Malaysia anda.",
    "Pick your stay": "Pilih penginapan anda",
    "Browse handpicked, verified homestays. Compare prices, see availability, and choose your dates.":
      "Layari homestay pilihan yang telah disahkan. Bandingkan harga, lihat ketersediaan, dan pilih tarikh anda.",
    "Pay securely via FPX": "Bayar dengan selamat melalui FPX",
    "Pay directly from your bank account through CHIP FPX — Malaysia's trusted online banking gateway. No card needed.":
      "Bayar terus daripada akaun bank anda melalui CHIP FPX — gerbang perbankan dalam talian Malaysia yang dipercayai. Tiada kad diperlukan.",
    "Enjoy your stay": "Nikmati penginapan anda",
    "Receive your booking confirmation and check-in details via email. Simply show up and enjoy your mountain stay.":
      "Terima pengesahan tempahan dan butiran daftar masuk melalui e-mel. Cukup sekadar hadir dan nikmati penginapan gunung anda.",
    "Questions? Email": "Ada soalan? E-mel",

    /* ---------------- Booking modal ---------------- */
    "Back": "Kembali",
    "Book Now": "Tempah Sekarang",
    "Confirm Your Booking": "Sahkan Tempahan Anda",
    "Select your dates to see the total price.": "Pilih tarikh anda untuk melihat jumlah harga.",
    "Stay:": "Penginapan:",
    "night": "malam",
    "nights": "malam",
    "Your payment is processed securely through CHIP FPX. We will never ask you to transfer to a personal account.":
      "Pembayaran anda diproses dengan selamat melalui CHIP FPX. Kami tidak akan sekali-kali meminta anda memindahkan wang ke akaun peribadi.",
    "Accepted Payment Methods": "Kaedah Pembayaran yang Diterima",
    "Malaysian Online Banking (FPX)": "Perbankan Dalam Talian Malaysia (FPX)",
    "Yes": "Ya",
    "Credit / Debit Card": "Kad Kredit / Debit",
    "Soon": "Akan Datang",
    "SSL Encrypted · Instant confirmation": "Disulitkan SSL · Pengesahan segera",
    "Please enter your full name.": "Sila masukkan nama penuh anda.",
    "Please enter a valid email address.": "Sila masukkan alamat e-mel yang sah.",
    "Please enter a valid Malaysian WhatsApp number.":
      "Sila masukkan nombor WhatsApp Malaysia yang sah.",
    "I have read and agree to the": "Saya telah membaca dan bersetuju dengan",
    "Cancellation & Refund Policy": "Dasar Pembatalan & Bayaran Balik",
    "Cancel": "Batal",
    "Pay via FPX": "Bayar melalui FPX",

    /* ---------------- Booking result screens ---------------- */
    "Booking Confirmed!": "Tempahan Disahkan!",
    "Welcome to Kundasang! Your reservation is securely logged.":
      "Selamat datang ke Kundasang! Tempahan anda direkodkan dengan selamat.",
    "Booking ID:": "ID Tempahan:",
    "Dates:": "Tarikh:",
    "Total Paid:": "Jumlah Dibayar:",
    "We have emailed your booking receipt and check-in instructions. Screenshot this receipt for your records. You can always find this booking under":
      "Kami telah menghantar resit tempahan dan arahan daftar masuk melalui e-mel. Simpan tangkapan skrin resit ini untuk rekod anda. Anda sentiasa boleh menemui tempahan ini di bawah",
    "View My Bookings →": "Lihat Tempahan Saya →",
    "💬 Send to Host": "💬 Hantar kepada Pengusaha",
    "Payment Not Completed": "Pembayaran Tidak Selesai",
    "No payment was completed. Your booking is saved and your dates are held for":
      "Tiada pembayaran diselesaikan. Tempahan anda disimpan dan tarikh anda ditahan selama",
    "5 minutes": "5 minit",
    "Please retry payment from": "Sila cuba semula pembayaran daripada",
    "instead — your original booking is still saved.":
      "— tempahan asal anda masih tersimpan.",
    "Total:": "Jumlah:",
    "Why the wait?": "Mengapa perlu menunggu?",
    "To prevent duplicate charges, the payment gateway requires a short cooldown period before you can retry.":
      "Untuk mengelakkan caj berganda, gerbang pembayaran memerlukan tempoh jeda seketika sebelum anda boleh cuba semula.",
    "Go to My Bookings →": "Pergi ke Tempahan Saya →",
    "Notice": "Notis",
    "Message": "Mesej"
  };

  /* Page titles, keyed by the exact English <title>. */
  var TITLES = {
    "Kundasang Homestay | Direct Local Booking in Kundasang":
      "Kundasang Homestay | Tempahan Terus di Kundasang",
    "Login - Kundasang Homestay | Sign In to Your Account":
      "Log Masuk - Kundasang Homestay",
    "Register - Kundasang Homestay | Create Your Account":
      "Daftar - Kundasang Homestay",
    "Forgot Password - Kundasang Homestay":
      "Lupa Kata Laluan - Kundasang Homestay"
  };

  /* ==================================================================== *
   * Language resolution:  ?lang=  >  saved choice  >  browser preference
   * ==================================================================== */
  function detect() {
    try {
      var qs = new URLSearchParams(location.search).get('lang');
      if (qs && SUPPORTED.indexOf(qs.toLowerCase()) !== -1) return qs.toLowerCase();
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.indexOf(saved) !== -1) return saved;
      if ((navigator.language || '').toLowerCase().indexOf('ms') === 0) return 'bm';
    } catch (e) { /* private mode — fall through to English */ }
    return 'en';
  }

  var LANG = detect();

  /* ==================================================================== *
   * Translation core
   * ==================================================================== */
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, TEXTAREA: 1 };
  var applying = false;

  function tr(text) {
    return Object.prototype.hasOwnProperty.call(BM, text) ? BM[text] : null;
  }

  /* Swap a text node's content while preserving its surrounding whitespace,
     so indentation and inline spacing are not disturbed. */
  function translateTextNode(node) {
    var raw = node.nodeValue;
    if (!raw) return;
    var trimmed = raw.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    var hit = tr(trimmed);
    if (hit === null) return;
    var next = raw.match(/^\s*/)[0] + hit + raw.match(/\s*$/)[0];
    if (next !== raw) node.nodeValue = next;
  }

  function translateAttributes(el) {
    var attrs = ['placeholder', 'title', 'aria-label'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (!v) continue;
      var hit = tr(v.replace(/\s+/g, ' ').trim());
      if (hit !== null) el.setAttribute(attrs[i], hit);
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateTextNode(root); return; }
    if (root.nodeType !== 1) return;
    if (SKIP_TAGS[root.tagName]) return;
    translateAttributes(root);
    var kids = root.childNodes;
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  }

  function apply() {
    applying = true;
    try {
      if (TITLES[document.title]) document.title = TITLES[document.title];
      walk(document.body);
      document.documentElement.setAttribute('lang', LANG === 'bm' ? 'ms' : 'en');
    } finally {
      /* MutationObserver callbacks are microtasks, so they run before this
         timer. Clearing the flag in a macrotask guarantees our own edits are
         never mistaken for the app re-rendering — otherwise we loop. */
      setTimeout(function () { applying = false; }, 0);
    }
  }

  /* Re-translate content the app renders after load. Debounced, so a burst
     of renders costs a single pass. */
  var pending = null;
  function schedule() {
    if (pending) clearTimeout(pending);
    pending = setTimeout(function () { pending = null; apply(); }, 60);
  }

  /* ==================================================================== *
   * Language toggle
   * Injected next to the mobile menu button, so no page markup changes.
   * ==================================================================== */
  function buildToggle() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'kdLangToggle';
    btn.textContent = LANG === 'bm' ? 'EN' : 'BM';
    btn.setAttribute('aria-label',
      LANG === 'bm' ? 'Tukar ke Bahasa Inggeris' : 'Tukar kepada Bahasa Malaysia');
    btn.title = LANG === 'bm' ? 'Tukar ke Bahasa Inggeris' : 'Tukar kepada Bahasa Malaysia';
    /* 40px circle matches the menu button. Verified not to push the
       hamburger off-screen at 320px — see the mobile header fix in
       styles.css, which this sits alongside. */
    btn.style.cssText = [
      'flex:0 0 auto',
      'width:40px',
      'height:40px',
      'border-radius:999px',
      'border:1px solid rgba(15,56,46,.25)',
      'background:#fff',
      'color:#0F382E',
      'font:700 12px/1 Poppins,system-ui,sans-serif',
      'letter-spacing:.04em',
      'cursor:pointer',
      'padding:0'
    ].join(';');

    btn.addEventListener('click', function () {
      var next = LANG === 'bm' ? 'en' : 'bm';
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
      /* Reload with ?lang= so we always translate from a clean English DOM. */
      var url = new URL(location.href);
      url.searchParams.set('lang', next);
      location.replace(url.toString());
    });

    return btn;
  }

  function mountToggle() {
    if (document.getElementById('kdLangToggle')) return;

    var btn = buildToggle();
    var row = document.querySelector('header > div');
    var hamburger = row ? row.querySelector('button.lg\\:hidden') : null;

    if (row && hamburger) {
      row.insertBefore(btn, hamburger);   // sits left of the menu button
    } else if (row) {
      row.appendChild(btn);               // desktop-only header
    } else {
      /* No <header> on this page (admin pages). Float it clear of the
         mobile nav so it does not overlap. */
      btn.style.position = 'fixed';
      btn.style.bottom = 'calc(84px + env(safe-area-inset-bottom, 0px))';
      btn.style.left = '12px';
      btn.style.zIndex = '2147483000';
      document.body.appendChild(btn);
    }
  }

  /* ==================================================================== */
  function boot() {
    if (LANG === 'bm') apply();
    mountToggle();

    if (LANG === 'bm') {
      var mo = new MutationObserver(function () { if (!applying) schedule(); });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
