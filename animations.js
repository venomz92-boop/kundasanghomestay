// =============================================================
// animations.js – COMPLETE (Chrome iOS compatible)
// =============================================================

// ---- 1. Define toggle function GLOBALLY ----
// This is called by the onclick attribute on the mobile menu button.
function toggleMobileMenu() {
    const nav = document.getElementById('mobileNav');
    if (nav) {
        nav.classList.toggle('open');
        // Prevent body scroll when menu is open
        document.body.style.overflow = nav.classList.contains('open') ? 'hidden' : '';
    }
}
window.toggleMobileMenu = toggleMobileMenu;

// ---- 2. DOM Ready ----
document.addEventListener('DOMContentLoaded', function() {

    // ---- Navbar scroll effect ----
    const header = document.querySelector('header');
    if (header) {
        let ticking = false;
        window.addEventListener('scroll', function() {
            if (!ticking) {
                window.requestAnimationFrame(function() {
                    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
                    if (scrollY > 80) {
                        header.classList.add('nav-scrolled');
                    } else {
                        header.classList.remove('nav-scrolled');
                    }
                    ticking = false;
                });
                ticking = true;
            }
        }, { passive: true });
    }

    // ---- Scroll reveal ----
    setTimeout(function() {
        const revealElements = document.querySelectorAll('.animate-on-scroll');
        if (revealElements.length > 0) {
            const observer = new IntersectionObserver(function(entries) {
                entries.forEach(function(entry) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('visible');
                        observer.unobserve(entry.target);
                    }
                });
            }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
            revealElements.forEach(function(el) {
                observer.observe(el);
            });
        }
    }, 200);

    // ---- Close menu on outside click ----
    document.addEventListener('click', function(e) {
        const nav = document.getElementById('mobileNav');
        const btn = document.getElementById('mobileMenuBtn');
        if (!nav || !btn) return;
        if (nav.classList.contains('open') && 
            !nav.contains(e.target) && 
            !btn.contains(e.target)) {
            nav.classList.remove('open');
            document.body.style.overflow = '';
        }
    });

    // ---- Close menu on Escape key ----
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const nav = document.getElementById('mobileNav');
            if (nav && nav.classList.contains('open')) {
                nav.classList.remove('open');
                document.body.style.overflow = '';
            }
        }
    });

});
