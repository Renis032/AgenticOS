'use strict';
// Keyboard and screen-reader access for the whole window. Clickable rows and cards (any [data-act] that isn't a
// button or link) become focusable and work with Enter and Space; icon-only buttons get their tooltip as a label.
// Runs after every render through one MutationObserver, so apps don't need to remember it.
function a11yPass(root) {
  for (const el of root.querySelectorAll('[data-act]:not(button):not(a):not(input):not(select):not(textarea):not([tabindex])')) {
    el.tabIndex = 0;
    if (!el.getAttribute('role')) el.setAttribute('role', 'button');
  }
  for (const el of root.querySelectorAll('a[data-act]:not([href]):not([tabindex])')) { el.tabIndex = 0; el.setAttribute('role', 'button'); }
  for (const el of root.querySelectorAll('button:not([aria-label]), [role=button]:not([aria-label])')) {
    if (el.textContent.trim()) continue;
    const label = el.dataset.tip || el.title;
    if (label) el.setAttribute('aria-label', label.split(' · ')[0]);
  }
}
new MutationObserver((list) => {
  for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) a11yPass(n.parentNode || n);
}).observe(document.body, { childList: true, subtree: true });
a11yPass(document.body);
addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target;
  if (!el || !el.matches || !el.matches('[data-act][role=button]:not(button)')) return;
  e.preventDefault();
  el.click();
});
