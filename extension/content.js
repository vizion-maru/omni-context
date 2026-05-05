/**
 * Omni-Context content script.
 * Extracts meaningful text from the current page and sends it to the background.
 * Runs in the page context — no ES modules.
 */
(() => {
  'use strict';

  const MAX_CONTENT_CHARS = 8000;

  // ── Text extraction ─────────────────────────────────────────────────────────

  function extractContent() {
    const title = document.title || '';
    const url = location.href;

    // Skip non-content pages
    if (isPdfOrBinary()) {
      return { title, url, content: buildUrlFallback(title, url) };
    }

    const parts = [];

    // Meta description — high-signal summary
    const meta = document.querySelector('meta[name="description"]');
    if (meta?.content) parts.push(meta.content.trim());

    // Primary: find semantic main content container.
    const MAIN_SELECTORS = [
      'article',
      '[role="main"]',
      'main',
      '.post-content',
      '.entry-content',
      '.article-body',
      '.content-body',
      '.prose',
      '#content',
      '#main-content',
      '.main-content',
      '.page-content',
    ].join(', ');

    const mainEl = document.querySelector(MAIN_SELECTORS);

    if (mainEl) {
      const text = mainEl.innerText?.trim() || '';
      if (text.length > 50) {
        parts.push(text);
      }
    }

    // Fallback: if content is still thin, use body.innerText.
    if (parts.join(' ').length < 300) {
      const bodyText = document.body?.innerText?.trim() || '';
      if (bodyText) parts.push(bodyText);
    }

    const content = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
    return { title, url, content };
  }

  function isPdfOrBinary() {
    const url = location.href.toLowerCase();
    return /\.(pdf|docx?|xlsx?|pptx?)(\?.*)?$/.test(url);
  }

  function buildUrlFallback(title, url) {
    try {
      const u = new URL(url);
      const path = decodeURIComponent(u.pathname).replace(/[/_\-.]+/g, ' ').trim();
      return [title, path, u.hostname].filter(Boolean).join(' ');
    } catch (_) {
      return title;
    }
  }

  // ── Auto-index on load (with idle delay) ────────────────────────────────────

  let indexed = false;

  function autoIndex() {
    if (indexed) return;
    indexed = true;
    const data = extractContent();
    chrome.runtime.sendMessage({ type: 'TAB_CONTENT', ...data }).catch(() => {});
  }

  if (document.readyState === 'complete') {
    setTimeout(autoIndex, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(autoIndex, 1500));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !indexed) autoIndex();
  });

  // ── Highlight passage (source chip click) ────────────────────────────────────

  let highlightOverlay = null;

  function highlightPassage(query) {
    // Remove existing highlight
    removeHighlight();

    if (!query || query.length < 3) return;

    // Try window.find() first (native browser search)
    window.getSelection()?.removeAllRanges();
    const found = window.find(query, false, false, true, false, false, false);

    if (found) {
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        // Scroll into view
        range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Create yellow overlay
        highlightOverlay = document.createElement('mark');
        highlightOverlay.style.cssText = `
          background: #fde68a;
          color: inherit;
          border-radius: 3px;
          padding: 1px 2px;
          transition: background 0.5s ease;
          box-shadow: 0 0 0 2px rgba(253, 230, 138, 0.4);
        `;

        try {
          range.surroundContents(highlightOverlay);
        } catch (_) {
          // surroundContents fails if range spans multiple nodes — fallback
          highlightOverlay = null;
          return;
        }

        // Fade out after 2 seconds
        setTimeout(() => {
          if (highlightOverlay) {
            highlightOverlay.style.background = 'transparent';
            highlightOverlay.style.boxShadow = 'none';
            setTimeout(removeHighlight, 600);
          }
        }, 2000);
      }
    } else {
      // Fallback: try to find a shorter substring
      const words = query.split(/\s+/);
      for (let i = 0; i < words.length - 1; i++) {
        const phrase = words.slice(i, i + 3).join(' ');
        if (phrase.length >= 6 && window.find(phrase, false, false, true, false, false, false)) {
          const sel = window.getSelection();
          if (sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
          }
        }
      }
    }
  }

  function removeHighlight() {
    if (highlightOverlay && highlightOverlay.parentNode) {
      const parent = highlightOverlay.parentNode;
      while (highlightOverlay.firstChild) {
        parent.insertBefore(highlightOverlay.firstChild, highlightOverlay);
      }
      parent.removeChild(highlightOverlay);
      parent.normalize();
    }
    highlightOverlay = null;
  }

  // ── Message handler ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTRACT_CONTENT') {
      try {
        const data = extractContent();
        sendResponse({ ok: true, ...data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return false;
    }

    if (msg.type === 'HIGHLIGHT_PASSAGE') {
      highlightPassage(msg.query);
      sendResponse({ ok: true });
      return false;
    }
  });
})();
