// ============================================================
// ANIMATIONS.JS – Enhanced for Kundasang Homestay
// ============================================================

// ----- Intersection Observer for fade-up -----
document.addEventListener('DOMContentLoaded', function() {
  const elements = document.querySelectorAll('.animate-on-scroll');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.animationPlayState = 'running';
      }
    });
  }, { threshold: 0.1 });
  elements.forEach(el => {
    el.style.animationPlayState = 'paused';
    observer.observe(el);
  });
});

// ----- Skeleton Loader -----
function showSkeleton(container, count = 6) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <div class="skeleton-card skeleton"></div>
    `;
  }
  container.innerHTML = html;
}

function hideSkeleton(container) {
  container.querySelectorAll('.skeleton').forEach(el => el.remove());
}

// ----- Staggered Reveal (for cards) -----
function staggerReveal(container, className = '.card') {
  const cards = container.querySelectorAll(className);
  cards.forEach((card, i) => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(20px)';
    setTimeout(() => {
      card.style.transition = 'all 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    }, i * 80);
  });
}

// ----- Back to Top Button (auto-created) -----
(function createBackToTop() {
  const btn = document.createElement('button');
  btn.id = 'backToTop';
  btn.innerHTML = '↑';
  btn.className = 'fixed bottom-24 right-4 z-50 bg-[#0F382E] text-white p-3 rounded-full shadow-lg hover:bg-[#1a4d3e] transition-opacity opacity-0 pointer-events-none text-xl';
  document.body.appendChild(btn);
  window.addEventListener('scroll', () => {
    if (window.scrollY > 300) {
      btn.classList.remove('opacity-0', 'pointer-events-none');
      btn.classList.add('opacity-100', 'pointer-events-auto');
    } else {
      btn.classList.add('opacity-0', 'pointer-events-none');
      btn.classList.remove('opacity-100', 'pointer-events-auto');
    }
  });
  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();

// ----- Export for usage -----
window.showSkeleton = showSkeleton;
window.hideSkeleton = hideSkeleton;
window.staggerReveal = staggerReveal;
