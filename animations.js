// =============================================================
// animations.js – Universal Fix (Chrome/Safari/Firefox)
// =============================================================

// ---- Define toggle function GLOBALLY ----
function toggleMobileMenu() {
    const nav = document.getElementById('mobileNav');
    if (nav) {
        nav.classList.toggle('open');
        document.body.style.overflow = nav.classList.contains('open') ? 'hidden' : '';
    }
}
window.toggleMobileMenu = toggleMobileMenu;

// ---- DOM Ready ----
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

    // ---- EVENT DELEGATION: Catch clicks on the menu button (works on Chrome) ----
    document.addEventListener('click', function(e) {
        const btn = document.getElementById('mobileMenuBtn');
        const nav = document.getElementById('mobileNav');

        // If the click is on the button or its children, toggle the menu
        if (btn && btn.contains(e.target)) {
            e.preventDefault();
            if (nav) {
                nav.classList.toggle('open');
                document.body.style.overflow = nav.classList.contains('open') ? 'hidden' : '';
            }
            return;
        }

        // If the click is outside the menu and the menu is open, close it
        if (nav && nav.classList.contains('open') && !nav.contains(e.target)) {
            nav.classList.remove('open');
            document.body.style.overflow = '';
        }
    });

    // ---- Touchstart event for Chrome (mobile) ----
    document.addEventListener('touchstart', function(e) {
        const btn = document.getElementById('mobileMenuBtn');
        const nav = document.getElementById('mobileNav');

        // Only act if the touch is on the button
        if (btn && btn.contains(e.target)) {
            e.preventDefault(); // Prevent default touch behavior
            if (nav) {
                nav.classList.toggle('open');
                document.body.style.overflow = nav.classList.contains('open') ? 'hidden' : '';
            }
        }
    }, { passive: false });

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
