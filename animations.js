// =============================================================
// ANIMATIONS – Kundasang Homestay (Safe Version)
// =============================================================

document.addEventListener('DOMContentLoaded', function() {

    // ---- 1. Navbar scroll effect (smooth) ----
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

    // ---- 2. Scroll reveal (only if elements exist) ----
    const revealElements = document.querySelectorAll('.animate-on-scroll');
    if (revealElements.length > 0) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    observer.unobserve(entry.target);
                }
            });
        }, {
            threshold: 0.1,
            rootMargin: '0px 0px -40px 0px'
        });
        revealElements.forEach(el => observer.observe(el));
    }

    // ---- 3. Stagger children (if any) ----
    document.querySelectorAll('.stagger-children').forEach(parent => {
        const children = parent.children;
        for (let i = 0; i < children.length; i++) {
            children[i].style.setProperty('--index', i);
        }
    });

    // ---- 4. Smooth anchor scroll (optional) ----
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
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

    console.log('✅ Animations initialized (safe)');
});
