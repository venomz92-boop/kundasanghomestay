// =========================================================
// ANIMATIONS – Kundasang Homestay
// =========================================================

document.addEventListener('DOMContentLoaded', function() {

    // ---- 1. Navbar scroll effect ----
    const header = document.querySelector('header');
    let lastScrollY = 0;

    if (header) {
        window.addEventListener('scroll', function() {
            const scrollY = window.pageYOffset || document.documentElement.scrollTop;
            if (scrollY > 80) {
                header.classList.add('nav-scrolled');
            } else {
                header.classList.remove('nav-scrolled');
            }
            lastScrollY = scrollY;
        }, { passive: true });
    }

    // ---- 2. Scroll reveal (Intersection Observer) ----
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                // Unobserve after reveal to improve performance
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -40px 0px'
    });

    // Select all elements with .animate-on-scroll
    document.querySelectorAll('.animate-on-scroll').forEach(el => {
        observer.observe(el);
    });

    // ---- 3. Stagger children (if .stagger-children) ----
    document.querySelectorAll('.stagger-children').forEach(parent => {
        const children = parent.children;
        for (let i = 0; i < children.length; i++) {
            children[i].style.setProperty('--index', i);
        }
    });

    // ---- 4. Smooth anchor scroll (if any internal links) ----
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

    console.log('✅ Animations initialized');
});