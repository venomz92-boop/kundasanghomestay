// =============================================================
// animations.js – COMPLETE (Chrome iOS compatible)
// =============================================================

// ---- 1. Define toggle function GLOBALLY ----
function toggleMobileMenu() {
    const nav = document.getElementById('mobileNav');
    if (nav) {
        nav.classList.toggle('open');
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
        }
    });

});
