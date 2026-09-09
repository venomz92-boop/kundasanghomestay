// =============================================================
// animations.js – COMPLETE (Chrome iOS compatible) – Robust
// =============================================================

// ---- 1. Define toggle function GLOBALLY (only if not already defined) ----
if (typeof window.toggleMobileMenu !== 'function') {
    window.toggleMobileMenu = function() {
        const nav = document.getElementById('mobileNav');
        if (nav) {
            nav.classList.toggle('open');
            // Prevent body scroll
            document.body.style.overflow = nav.classList.contains('open') ? 'hidden' : '';
        }
    };
}

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

    // ---- Close mobile nav on outside click (fallback) ----
    // This is also handled in the inline script, but we keep it here as a backup.
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

});
