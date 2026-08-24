// =============================================================
// animations.js – Safe for ALL pages + Mobile Menu (Chrome fix)
// =============================================================

document.addEventListener('DOMContentLoaded', function() {

    // ---- 1. Navbar scroll effect ----
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

    // ---- 2. Scroll reveal for .animate-on-scroll ----
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

    // ---- 3. Smooth anchor scroll ----
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

    // ---- 4. Mobile Menu Setup (works on ALL browsers) ----
    setupMobileMenu();

    console.log('✅ Animations loaded (all pages)');
});

// =============================================================
// MOBILE MENU – Works on Safari, Chrome, all browsers
// =============================================================

function setupMobileMenu() {
    const menuBtn = document.getElementById('mobileMenuBtn');
    const nav = document.getElementById('mobileNav');

    if (!menuBtn || !nav) {
        console.warn('⚠️ Mobile menu elements not found on this page');
        return;
    }

    // Remove any existing listeners (prevent duplicates)
    const newBtn = menuBtn.cloneNode(true);
    menuBtn.parentNode.replaceChild(newBtn, menuBtn);

    // Click to toggle menu
    newBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        nav.classList.toggle('open');
        console.log('📱 Menu toggled:', nav.classList.contains('open') ? 'open' : 'closed');
    });

    // Close menu when clicking outside
    document.addEventListener('click', function(e) {
        if (nav.classList.contains('open') && 
            !nav.contains(e.target) && 
            e.target !== newBtn && 
            !newBtn.contains(e.target)) {
            nav.classList.remove('open');
        }
    });

    // Close menu on escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && nav.classList.contains('open')) {
            nav.classList.remove('open');
        }
    });

    console.log('✅ Mobile menu setup complete');
}

// Fallback for inline onclick="toggleMobileMenu()"
function toggleMobileMenu() {
    const nav = document.getElementById('mobileNav');
    if (nav) {
        nav.classList.toggle('open');
        console.log('📱 toggleMobileMenu called');
    }
}
window.toggleMobileMenu = toggleMobileMenu;

console.log('✅ Mobile menu loaded (global)');
