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
   *
   * Deliberately NOT translated:
   *   - Brand and proper nouns (Kundasang, Kinabalu, Ranau, Mesilau,
   *     Bundu Tuhan, NICK'S CREATIONS, CHIP, FPX, WhatsApp, Facebook)
   *   - Technical tokens Malaysians use in English (FPX, SSL, WhatsApp)
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
    "Message": "Mesej",

    /* ================================================================ *
     * list.html — Host property submission form
     * (Highest-value page for BM: the audience is Malaysian hosts.)
     * ================================================================ */
    "Grow Your Business": "Kembangkan Perniagaan Anda",
    "Host In Kundasang": "Jadi Pengusaha di Kundasang",
    "List your property with Sabah's primary verified homestay system. Keep 100% control of your nights and payouts.":
      "Senaraikan hartanah anda dengan sistem homestay disahkan yang utama di Sabah. Kekalkan kawalan 100% ke atas malam dan pembayaran anda.",
    "Register Your Homestay": "Daftarkan Homestay Anda",
    "Pending": "Menunggu",
    "⏳ Approved within 24 Hours": "⏳ Diluluskan dalam 24 Jam",
    "🔒 AES-256 Local Encryption Secured": "🔒 Disulitkan AES-256 Secara Setempat",
    "A verified host account is required before you can list a property":
      "Akaun pengusaha yang disahkan diperlukan sebelum anda boleh menyenaraikan hartanah",
    "This protects guests from fake listings. Create a free host account, verify your email (1 minute), then return here to submit your property details.":
      "Ini melindungi tetamu daripada penyenaraian palsu. Buat akaun pengusaha secara percuma, sahkan e-mel anda (1 minit), kemudian kembali ke sini untuk menghantar butiran hartanah anda.",
    "Create Host Account": "Buat Akaun Pengusaha",
    "I already have one": "Saya sudah ada akaun",
    "Host Details": "Butiran Pengusaha",
    "Full Host Name (as in IC / License) *": "Nama Penuh Pengusaha (seperti dalam KP / Lesen) *",
    "WhatsApp Contact Number *": "Nombor Hubungan WhatsApp *",
    "For automated guest receipts and direct check-in messages.":
      "Untuk resit tetamu automatik dan mesej daftar masuk terus.",
    "Active Email Address *": "Alamat E-mel Aktif *",
    "Property Details": "Butiran Hartanah",
    "Homestay Display Name *": "Nama Paparan Homestay *",
    "Location / Area *": "Lokasi / Kawasan *",
    "Price per Night (RM) *": "Harga Semalam (RM) *",
    "Max Guest Capacity *": "Kapasiti Tetamu Maksimum *",
    "Total Bedrooms *": "Jumlah Bilik Tidur *",
    "Property Description *": "Penerangan Hartanah *",
    "Rooms & Pricing": "Bilik & Harga",
    "Multi‑room support": "Sokongan berbilang bilik",
    "Add each room type separately. You can upload photos for each room.":
      "Tambah setiap jenis bilik secara berasingan. Anda boleh memuat naik gambar untuk setiap bilik.",
    "+ Add Room": "+ Tambah Bilik",
    "Escrow Account Details": "Butiran Akaun Amanah (Eskrow)",
    "Secure booking settlement runs direct. Account details provided must correlate to host legal identity.":
      "Penyelesaian tempahan yang selamat dijalankan secara terus. Butiran akaun yang diberikan mesti sepadan dengan identiti sah pengusaha.",
    "Receiving Bank *": "Bank Penerima *",
    "Loading banks…": "Memuatkan bank…",
    "Only banks supported by CHIP Send are listed. This is the account that will receive your payouts.":
      "Hanya bank yang disokong oleh CHIP Send disenaraikan. Inilah akaun yang akan menerima pembayaran anda.",
    "Bank Account Number *": "Nombor Akaun Bank *",
    "Beneficiary Account Name *": "Nama Akaun Benefisiari *",
    "DuitNow / Bank QR Code Template *": "Templat Kod QR DuitNow / Bank *",
    "Upload your bank QR code image so guests can scan directly on success modals.":
      "Muat naik gambar kod QR bank anda supaya tetamu boleh mengimbas terus pada tetingkap kejayaan.",
    "Click to select DuitNow / Bank QR image": "Klik untuk pilih gambar DuitNow / Kod QR Bank",
    "Accepts JPG, PNG up to 3MB": "Menerima JPG, PNG sehingga 3MB",
    "Remove Image": "Buang Gambar",
    "I confirm that this bank account matches my Host Name as per identification documents.":
      "Saya mengesahkan bahawa akaun bank ini sepadan dengan Nama Pengusaha saya seperti dalam dokumen pengenalan diri.",
    "Property Gallery": "Galeri Hartanah",
    "Click to select 3-5 high-resolution photos of your property":
      "Klik untuk pilih 3-5 gambar hartanah anda beresolusi tinggi",
    "Primary photo will represent listing cover thumbnail":
      "Gambar utama akan menjadi thumbnail muka depan penyenaraian",
    "Secure Host Verification": "Pengesahan Pengusaha yang Selamat",
    "To prevent fraud, submit a photo of your national IC (Front). A persistent security watermark is drawn inside your browser window before raw file transmission.":
      "Untuk mencegah penipuan, hantar gambar Kad Pengenalan (Depan) anda. Tera air keselamatan kekal dilukis dalam tetingkap pelayar anda sebelum fail dihantar.",
    "Full Legal Name as in IC *": "Nama Penuh Seperti dalam KP *",
    "IC Number (optional)": "Nombor Kad Pengenalan (pilihan)",
    "Upload IC (Selfie with IC) image *": "Muat Naik Gambar KP (Selfie dengan KP) *",
    "Click to select IC document photo": "Klik untuk pilih gambar dokumen Kad Pengenalan",
    "Secure client-side watermarks are auto-applied":
      "Tera air selamat di pihak klien digunakan secara automatik",
    "Secured Document Preview:": "Pratonton Dokumen Selamat:",
    "Cancel Identification Upload": "Batal Muat Naik Pengenalan",
    "PBT Trading License": "Lesen Perniagaan PBT",
    "Upload": "Muat Naik",
    "PBT (Pihak Berkuasa Tempatan)": "PBT (Pihak Berkuasa Tempatan)",
    "trading license here.": "lesen perniagaan di sini.",
    "Not digital PBT.": "Bukan PBT digital.",
    "This adds extra credibility for approval to your listing.":
      "Ini menambah kredibiliti tambahan untuk kelulusan penyenaraian anda.",
    "Upload License (JPG/PNG)": "Muat Naik Lesen (JPG/PNG)",
    "Tap to select or take a photo": "Ketik untuk pilih atau ambil gambar",
    "License Preview:": "Pratonton Lesen:",
    "Remove": "Buang",
    "Verify with Host Account Password": "Sahkan dengan Kata Laluan Akaun Pengusaha",
    "🔑 Password must match an existing verified host account.":
      "🔑 Kata laluan mesti sepadan dengan akaun pengusaha yang telah disahkan.",
    "Type the password you used when you": "Taip kata laluan yang anda gunakan semasa anda",
    "created your host account": "membuat akaun pengusaha anda",
    ". If you haven't created one yet, please do that first — the property submission will be rejected without it.":
      ". Jika anda belum membuatnya, sila buat dahulu — penghantaran hartanah akan ditolak tanpanya.",
    "Host Account Password *": "Kata Laluan Akaun Pengusaha *",
    "Availability Exclusions": "Pengecualian Ketersediaan",
    "Mark dates that are unavailable (such as personal use, maintenance, or off-site bookings).":
      "Tandakan tarikh yang tidak tersedia (seperti kegunaan peribadi, penyelenggaraan, atau tempahan luar).",
    "+ Block Date": "+ Sekat Tarikh",
    "Block Range": "Sekat Julat",
    "0 Dates Blocked": "0 Tarikh Disekat",
    "Data Privacy & Consent": "Privasi Data & Persetujuan",
    "Your IC, bank QR, and PBT trading license images are used":
      "Gambar Kad Pengenalan, kod QR bank, dan lesen perniagaan PBT anda digunakan",
    "only for one‑time verification": "hanya untuk pengesahan sekali sahaja",
    ". They are": ". Ia",
    "automatically and permanently deleted": "dipadam secara automatik dan kekal",
    "from our servers once your listing is approved or rejected. We store only your name, contact details, and bank account information for payout purposes.":
      "daripada pelayan kami sebaik sahaja penyenaraian anda diluluskan atau ditolak. Kami hanya menyimpan nama, butiran hubungan, dan maklumat akaun bank anda untuk tujuan pembayaran.",
    "I consent to my data being processed for verification, listing, and payout purposes as described above.":
      "Saya bersetuju data saya diproses untuk tujuan pengesahan, penyenaraian, dan pembayaran seperti yang dinyatakan di atas.",
    "Host Agreement": "Perjanjian Pengusaha",
    "and": "dan",
    "Submit Homestay Listing for Approval": "Hantar Penyenaraian Homestay untuk Kelulusan",
    "By compiling this form, you acknowledge our registration policies. IC and financial records are held strictly in compliance with Sabah cyber security frameworks.":
      "Dengan melengkapkan borang ini, anda mengakui dasar pendaftaran kami. Rekod Kad Pengenalan dan kewangan disimpan dengan patuh pada rangka kerja keselamatan siber Sabah.",
    "Verified guest": "Tetamu Disahkan",

    /* ---------------- list.html — JS status & validation ---------------- */
    "Upload Failed": "Muat Naik Gagal",
    "Upload Error": "Ralat Muat Naik",
    "File Exceeded": "Fail Melebihi Had",
    "Error": "Ralat",
    "Warning": "Amaran",
    "Define End Date": "Tentukan Tarikh Tamat",
    "Invalid Date": "Tarikh Tidak Sah",
    "Invalid Range": "Julat Tidak Sah",
    "Bank Required": "Bank Diperlukan",
    "Consent Required": "Persetujuan Diperlukan",
    "Agreement Required": "Perjanjian Diperlukan",
    "Required Field": "Ruangan Diperlukan",
    "Escrow Agreement": "Perjanjian Amanah (Eskrow)",
    "Host Account Required": "Akaun Pengusaha Diperlukan",
    "Invalid Host Password": "Kata Laluan Pengusaha Tidak Sah",
    "Invalid Bank": "Bank Tidak Sah",
    "Listing Already On File": "Penyenaraian Sudah dalam Rekod",
    "Listing Sent": "Penyenaraian Dihantar",
    "Submitting…": "Menghantar…",
    "⏳ Initializing client-to-cloud security handshake...":
      "⏳ Memulakan jabat tangan keselamatan klien ke awan...",
    "⏰ Your host session expired — please log in again...":
      "⏰ Sesi pengusaha anda telah tamat — sila log masuk semula...",
    "🔐 Host account required — redirecting you to create one...":
      "🔐 Akaun pengusaha diperlukan — membawa anda untuk membuat akaun...",
    "✓ Secure cloud storage synchronized successfully!":
      "✓ Storan awan selamat berjaya disegerakkan!",
    "⚠️ Operation Interrupted:": "⚠️ Operasi Terhenti:"
   };  
       
    /* ================================================================ *
     * owner.html — Host dashboard
     * ================================================================ */

    /* --- Header / nav --- */
    "Host Portal": "Portal Pengusaha",
    "Support": "Sokongan",
    "Host :": "Pengusaha :",
    "🏠 View Website": "🏠 Lihat Laman Web",
    "✉️ Support": "✉️ Sokongan",
    "🏡 List Property": "🏡 Senaraikan Hartanah",
    "Host Dashboard": "Papan Pemuka Pengusaha",
    "Host:": "Pengusaha:",
    "📊 Dashboard": "📊 Papan Pemuka",
    "Owner": "Pengusaha",
    "View Website": "Lihat Laman Web",

    /* --- Login --- */
    "Host Login": "Log Masuk Pengusaha",
    "Log in with your registered WhatsApp number and password.":
      "Log masuk dengan nombor WhatsApp berdaftar dan kata laluan anda.",
    "WhatsApp Number": "Nombor WhatsApp",
    "Dashboard Password": "Kata Laluan Papan Pemuka",
    "Enter Dashboard": "Masuk Papan Pemuka",
    "Never received the verification email, or the link expired?":
      "Tidak pernah menerima e-mel pengesahan, atau pautan telah luput?",
    "✉️ Resend verification email": "✉️ Hantar semula e-mel pengesahan",

    /* --- Dashboard header --- */
    "Welcome,": "Selamat datang,",
    "Manage your bookings, block dates, and track your earnings.":
      "Uruskan tempahan anda, sekat tarikh, dan pantau pendapatan anda.",
    "🔄 Refresh": "🔄 Muat Semula",

    /* --- Metrics --- */
    "Total Earnings": "Jumlah Pendapatan",
    "Disbursed after guest check-in": "Dibayar selepas tetamu daftar masuk",
    "Completed Stays": "Penginapan Selesai",
    "Checked-in and finished transactions": "Transaksi yang sudah daftar masuk dan selesai",
    "Upcoming Stays": "Penginapan Akan Datang",
    "Guests arriving soon": "Tetamu yang akan tiba",

    /* --- Cancellation requests --- */
    "✋ Cancellation Requests": "✋ Permintaan Pembatalan",
    "A guest has asked to cancel.": "Seorang tetamu telah meminta pembatalan.",
    "You decide.": "Anda yang tentukan.",
    "You must reply within 48 hours — or 6 hours if check-in is within 2 days. If you decline, say why: the guest can ask us to review it.":
      "Anda mesti membalas dalam masa 48 jam — atau 6 jam jika daftar masuk dalam tempoh 2 hari. Jika anda menolak, nyatakan sebabnya: tetamu boleh meminta kami menyemaknya.",

    /* --- Sections --- */
    "Property Scope:": "Skop Hartanah:",
    "📅 Reservation Books": "📅 Buku Tempahan",
    "Loading your bookings...": "Memuatkan tempahan anda...",
    "🛏️ Manage Rooms": "🛏️ Urus Bilik",
    "Select a specific homestay above to manage its rooms.":
      "Pilih homestay tertentu di atas untuk menguruskan biliknya.",
    "🚫 Block Dates": "🚫 Sekat Tarikh",

    /* --- Block dates (the copy we wrote earlier) --- */
    "Block a": "Sekat",
    "whole property": "seluruh hartanah",
    "(for example when you are away) or a single room. Pick the dates you want to close, then press Add Block. This stops new bookings only — it does not cancel a booking that already exists.":
      "(contohnya apabila anda berada di luar kawasan) atau satu bilik sahaja. Pilih tarikh yang anda mahu tutup, kemudian tekan Tambah Sekatan. Ini hanya menghalang tempahan baharu — ia tidak membatalkan tempahan yang sudah ada.",
    "+ Add Block": "+ Tambah Sekatan",

    /* --- Nightly rate --- */
    "💰 Update Nightly Rate": "💰 Kemas Kini Kadar Semalaman",
    "Current Price per Night (RM)": "Harga Semasa Semalam (RM)",
    "Update Price": "Kemas Kini Harga",
    "Update the base price for the selected homestay. All future bookings will use this new price.":
      "Kemas kini harga asas untuk homestay yang dipilih. Semua tempahan akan datang akan menggunakan harga baharu ini.",
    "Tip: Most Kundasang homestays charge between RM 150 and RM 350 per night.":
      "Petua: Kebanyakan homestay di Kundasang mengenakan kadar antara RM 150 hingga RM 350 semalam.",

    /* --- Payout & cancellation rules table --- */
    "💸 Payout & Cancellation Rules": "💸 Peraturan Pembayaran & Pembatalan",
    "What you and your guest receive in each situation. Amounts use a":
      "Apa yang anda dan tetamu anda terima dalam setiap keadaan. Jumlah menggunakan",
    "room for": "bilik untuk",
    "1 night": "1 malam",
    "as the example — so the guest paid": "sebagai contoh — jadi tetamu membayar",
    "(RM 250.00 room + 11% service fee RM 27.50 + RM 1.00 gateway fee). Your real amounts depend on the booking.":
      "(RM 250.00 bilik + 11% fi perkhidmatan RM 27.50 + RM 1.00 fi gerbang). Jumlah sebenar anda bergantung pada tempahan tersebut.",
    "Situation": "Keadaan",
    "You receive": "Anda terima",
    "Guest refunded": "Tetamu dibayar balik",
    "Who decides": "Siapa yang tentukan",
    "✅ Guest checks in normally": "✅ Tetamu daftar masuk seperti biasa",
    "full room price": "harga penuh bilik",
    "No action needed": "Tiada tindakan diperlukan",
    "🟡 Guest asks to cancel — Tier A": "🟡 Tetamu minta batal — Tahap A",
    "(14+ days before)": "(14+ hari sebelum)",
    "everything paid, less RM 1.00": "semua yang dibayar, ditolak RM 1.00",
    "You accept — plenty of time to resell": "Anda terima — banyak masa untuk tempah semula",
    "🟠 Guest asks to cancel — Tier B": "🟠 Tetamu minta batal — Tahap B",
    "(2 to 13 days)": "(2 hingga 13 hari)",
    "half the room price": "separuh harga bilik",
    "You accept — short notice": "Anda terima — notis singkat",
    "🟢 You cancel the booking": "🟢 Anda batalkan tempahan",
    "everything they paid": "semua yang mereka bayar",
    "You": "Anda",
    "🔵 Platform cancels": "🔵 Platform batalkan",
    "⚪ Guest never arrives, no contact": "⚪ Tetamu tidak hadir, tiada hubung",
    "Rule applies automatically after 24 hours": "Peraturan digunakan secara automatik selepas 24 jam",
    "🟣 Guest never arrives, emergency approved": "🟣 Tetamu tidak hadir, kecemasan diluluskan",
    "50% of room price": "50% daripada harga bilik",
    "Kundasang Homestay reviews the evidence": "Kundasang Homestay menyemak bukti",

    /* --- Payout info cards --- */
    "Payout timing": "Masa pembayaran",
    "1–2 business days": "1–2 hari bekerja",
    "After you confirm the guest's 6-digit check-in code. Weekend or holiday check-ins pay out the next business day.":
      "Selepas anda mengesahkan kod daftar masuk 6 digit tetamu. Daftar masuk pada hujung minggu atau cuti akan dibayar pada hari bekerja berikutnya.",
    "What we keep": "Apa yang kami ambil",
    "Service fee + gateway fee": "Fi perkhidmatan + fi gerbang",
    "RM 28.50 on this example — paid by the guest, never deducted from your room price. Zero commission from hosts.":
      "RM 28.50 dalam contoh ini — dibayar oleh tetamu, tidak pernah ditolak daripada harga bilik anda. Sifar komisen daripada pengusaha.",
    "Refunds": "Bayaran Balik",
    "1–7 business days": "1–7 hari bekerja",
    "Issued by us via CHIP back to the guest's bank. You never handle a refund yourself.":
      "Dikeluarkan oleh kami melalui CHIP kembali ke bank tetamu. Anda tidak perlu mengendalikan bayaran balik sendiri.",
    "We review emergency no-shows ourselves, using the facts you give us — was the guest in contact, and was the night resold. You are never asked to decide your own refund, because the refund is deducted from your payout. Full wording is in the":
      "Kami menyemak kes tidak hadir kecemasan sendiri, menggunakan fakta yang anda berikan — adakah tetamu menghubungi, dan adakah malam itu ditempah semula. Anda tidak pernah diminta memutuskan bayaran balik anda sendiri, kerana bayaran balik itu ditolak daripada pembayaran anda. Butir penuh ada dalam",

    /* --- Account settings --- */
    "Account Settings": "Tetapan Akaun",
    "Delete My Host Account": "Padam Akaun Pengusaha Saya",
    "Permanently delete your host account and remove all your listings. Past booking records stay in our accounting system, but your personal details will be removed.":
      "Padam akaun pengusaha anda secara kekal dan buang semua penyenaraian anda. Rekod tempahan lepas kekal dalam sistem perakaunan kami, tetapi butiran peribadi anda akan dibuang.",
    "Delete Account": "Padam Akaun",

    /* --- Footer --- */
    "Host portal for managing verified Kundasang homestay listings, bookings, dates, and earnings.":
      "Portal pengusaha untuk menguruskan penyenaraian homestay Kundasang yang disahkan, tempahan, tarikh, dan pendapatan.",
    "Host Links": "Pautan Pengusaha",
    "Policies": "Dasar",
    "✓ Host ID Verification (IC + bank proof)": "✓ Pengesahan ID Pengusaha (KP + bukti bank)",
    "✓ Payments via CHIP (FPX)": "✓ Pembayaran melalui CHIP (FPX)",
    "✓ Payout 1–2 business days after check-in": "✓ Pembayaran 1–2 hari bekerja selepas daftar masuk",
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
      "Lupa Kata Laluan - Kundasang Homestay",
    "List Your Property - Kundasang Homestay Host Portal":
      "Senaraikan Hartanah Anda - Portal Pengusaha Kundasang Homestay"
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
       hamburger off-screen at 320px. */
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
      row.insertBefore(btn, hamburger);   /* sits left of the menu button */
    } else if (row) {
      row.appendChild(btn);               /* desktop-only header */
    } else {
      /* No <header> on this page. Float it clear of the mobile nav. */
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
