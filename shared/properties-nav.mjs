/**
 * Injects a "Properties" button that links back to the property index.
 * Call from any property page: adds the button to menu-container or as a fixed top-left link.
 */
(function() {
  const link = document.createElement('a');
  link.href = '/';
  link.className = 'menu-button properties-nav-btn';
  link.setAttribute('title', 'Properties');
  link.setAttribute('aria-label', 'Back to Properties');
  link.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
  link.style.textDecoration = 'none';
  link.style.color = 'inherit';

  const menu = document.getElementById('menuContainer');
  if (menu && menu.appendChild) {
    menu.insertBefore(link, menu.firstChild);
    return;
  }

  // No menu-container (e.g. 46th-Street, Park-Road): fixed top-left button
  link.style.position = 'fixed';
  link.style.top = '16px';
  link.style.left = '16px';
  link.style.zIndex = '100';
  link.style.width = '44px';
  link.style.height = '44px';
  link.style.display = 'inline-flex';
  link.style.alignItems = 'center';
  link.style.justifyContent = 'center';
  link.style.borderRadius = '50%';
  link.style.background = 'rgba(128,128,128,0.3)';
  link.style.backdropFilter = 'blur(50px)';
  link.style.border = '1px solid rgba(255,255,255,0.2)';
  link.style.color = 'rgba(255,255,255,0.95)';
  link.querySelector('svg').style.width = '22px';
  link.querySelector('svg').style.height = '22px';
  document.body.appendChild(link);
})();
