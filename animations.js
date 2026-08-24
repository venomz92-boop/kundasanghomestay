// =============================================================
// MINIMAL animations.js – ONLY menu toggle (for Chrome debugging)
// =============================================================

// ---- Define toggle function GLOBALLY ----
function toggleMobileMenu() {
    var nav = document.getElementById('mobileNav');
    if (nav) {
        nav.classList.toggle('open');
        console.log('📱 Menu toggled:', nav.classList.contains('open') ? 'open' : 'closed');
    } else {
        console.warn('⚠️ #mobileNav not found');
    }
}

// Make it globally available
window.toggleMobileMenu = toggleMobileMenu;

console.log('✅ toggleMobileMenu loaded (minimal)');
