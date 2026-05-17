/**
 * PDF text extractor for Omni-Context.
 *
 * Runs inside the MV3 service worker. PDF.js automatically falls into
 * "fake worker" (in-thread) mode because `window` is undefined in a
 * service worker — the try/catch in PDFWorker._initialize() catches the
 * ReferenceError and calls _setupFakeWorker(), which dynamically imports
 * the worker module via the workerSrc URL and uses a LoopbackPort.
 */

import { getDocument, GlobalWorkerOptions } from './pdf.min.mjs';

// Must be set before any getDocument() call.
// chrome.runtime.getURL resolves to the extension-bundled worker file.
GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const MAX_CONTENT_CHARS = 8000;

/**
 * Fetch a PDF from `url` and extract its text content.
 *
 * @param {string} url  Full URL of the PDF (http/https only; file:// will throw).
 * @returns {Promise<{title: string, url: string, content: string}>}
 * @throws {Error} on fetch failure, CORS block, or unreadable/encrypted PDF.
 */
export async function extractPdfText(url) {
  // ── Step 1: fetch bytes ──────────────────────────────────────────────────────
  let arrayBuffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    arrayBuffer = await res.arrayBuffer();
  } catch (err) {
    throw new Error(`PDF fetch failed: ${err.message}`);
  }

  // ── Step 2: parse ────────────────────────────────────────────────────────────
  let pdf;
  try {
    pdf = await getDocument({
      data: arrayBuffer,
      // Disable features that try to access the DOM or spawn sub-workers
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    throw new Error(`PDF parse failed: ${err.message}`);
  }

  // ── Step 3: extract text page by page ────────────────────────────────────────
  const { numPages } = pdf;
  const parts = [];
  let totalChars = 0;

  for (let n = 1; n <= numPages && totalChars < MAX_CONTENT_CHARS; n++) {
    try {
      const page = await pdf.getPage(n);
      const textContent = await page.getTextContent();

      // Join text items; preserve paragraph spacing with double space between items
      const pageText = textContent.items
        .map(item => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (pageText) {
        parts.push(pageText);
        totalChars += pageText.length;
      }

      page.cleanup();
    } catch (_) {
      // Skip pages that fail (e.g., image-only pages)
    }
  }

  const content = parts.join('\n\n').slice(0, MAX_CONTENT_CHARS);

  // ── Step 4: document title ───────────────────────────────────────────────────
  let title = '';
  try {
    const { info } = await pdf.getMetadata();
    title = (info?.Title || '').trim();
  } catch (_) {}

  if (!title) {
    try {
      const pathname = new URL(url).pathname;
      const filename = decodeURIComponent(pathname.split('/').pop() || '');
      title = filename.replace(/\.pdf$/i, '') || new URL(url).hostname;
    } catch (_) {
      title = url;
    }
  }

  await pdf.destroy();

  return { title, url, content };
}
