/**
 * Theme pre-loader — runs synchronously in <head> before page paint.
 * Reads the user's persisted theme preference from chrome.storage.sync
 * and applies it to <html data-theme="..."> to prevent a flash of
 * incorrect theme (FOIT) on page load.
 *
 * If storage is unavailable or the value is 'system' (OS-level preference),
 * no data-theme attribute is set, letting CSS @media (prefers-color-scheme)
 * handle the theme naturally.
 *
 * @see options.js — initTheme() for the full theme switching logic.
 */
chrome.storage.sync.get('theme').then(r => {
  if (r.theme && r.theme !== 'system') document.documentElement.dataset.theme = r.theme;
}).catch(() => {
  // Storage unavailable (e.g., extension context invalidated, first-install race).
  // Gracefully degrade — CSS media queries will provide the correct theme.
});
