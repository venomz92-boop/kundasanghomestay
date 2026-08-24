// =============================================================
// animations.js – Safe for ALL pages (no errors)
// =============================================================

document.addEventListener('DOMContentLoaded', function() {

    // ---- 1. Navbar scroll effect (only if header exists) ----
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
        console.log('✅ Navbar animation loaded');
    }

    // ---- 2. Scroll reveal for .animate-on-scroll (only if elements exist) ----
    // We'll run this after a small delay to ensure content is rendered
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
            console.log('✅ Scroll reveal loaded for ' + revealElements.length + ' elements');
        } else {
            console.log('ℹ️ No .animate-on-scroll elements found on this page');
        }
    }, 200);

    // ---- 3. Smooth anchor scroll (optional) ----
    document.querySelectorAll('a[href^="#"]').forEach(function(anchor) {
        anchor.addEventListener('click', function(e) {
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            const target = document.querySelector(targetId);
            if (target) {
                e.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });

    console.log('✅ Animations initialized (safe for all pages)');
});

// =============================================================
// MOBILE MENU – Global toggle (works on ALL pages)
// =============================================================

function toggleMobileMenu() {
    const nav = document.getElementById('mobileNav');
    if (nav) {
        nav.classList.toggle('open');
        console.log('📱 Mobile menu toggled:', nav.classList.contains('open') ? 'open' : 'closed');
    } else {
        console.warn('⚠️ #mobileNav not found on this page');
    }
}

// Make it available globally (for inline onclick)
window.toggleMobileMenu = toggleMobileMenu;

// Close mobile menu when clicking outside
document.addEventListener('click', function(e) {
    const nav = document.getElementById('mobileNav');
    const btn = document.getElementById('mobileMenuBtn');
    if (!nav || !btn) return;
    if (nav.classList.contains('open') && 
        !nav.contains(e.target) && 
        !btn.contains(e.target)) {
        nav.classList.remove('open');
        console.log('📱 Mobile menu closed (outside click)');
    }
});

console.log('✅ Mobile menu loaded (global)');
