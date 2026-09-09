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

// ----- Export for usage -----
window.showSkeleton = showSkeleton;
window.hideSkeleton = hideSkeleton;
window.staggerReveal = staggerReveal;
