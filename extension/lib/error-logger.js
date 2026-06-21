/**
 * Error ring buffer for Omni-Context.
 * Captures errors that would otherwise be silently swallowed in catch blocks.
 * Persists to chrome.storage.local so errors survive service worker restarts.
 */

const MAX_ENTRIES = 100;
const PERSIST_DEBOUNCE_MS = 5000;
const STORAGE_KEY = 'errorLog';

const _buffer = [];
let _persistTimer = null;

/**
 * Log an error into the ring buffer.
 * @param {string} source  Origin identifier, e.g. 'background:extractAndIndex'.
 * @param {Error|string} err  The caught error or message string.
 */
function log(source, err) {
  _buffer.push({
    timestamp: Date.now(),
    source: source || 'unknown',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  while (_buffer.length > MAX_ENTRIES) {
    _buffer.shift();
  }

  _schedulePersist();
}

async function persist() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: _buffer.slice() });
  } catch (_) {
    // Avoid infinite recursion — storage write itself failed
  }
}

async function load() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY];
    if (Array.isArray(stored)) {
      _buffer.length = 0;
      const start = Math.max(0, stored.length - MAX_ENTRIES);
      for (let i = start; i < stored.length; i++) {
        _buffer.push(stored[i]);
      }
    }
  } catch (_) {
    // Storage read failed — start with empty buffer
  }
}

/**
 * @returns {Array<{timestamp: number, source: string, message: string, stack?: string}>}
 */
function getAll() {
  return _buffer.slice();
}

async function clear() {
  _buffer.length = 0;
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch (_) {
    // Ignore — clearing is best-effort
  }
}

function _schedulePersist() {
  if (_persistTimer !== null) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persist();
  }, PERSIST_DEBOUNCE_MS);
}

export const errorLogger = { log, persist, load, getAll, clear };
