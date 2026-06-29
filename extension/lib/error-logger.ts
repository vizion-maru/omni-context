/**
 * Error ring buffer for Omni-Context.
 * Captures errors that would otherwise be silently swallowed in catch blocks.
 * Persists to chrome.storage.local so errors survive service worker restarts.
 */

export interface ErrorLogEntry {
  timestamp: number;
  source: string;
  message: string;
  stack?: string;
}

const MAX_ENTRIES = 100;
const PERSIST_DEBOUNCE_MS = 5000;
const STORAGE_KEY = 'errorLog';

const _buffer: ErrorLogEntry[] = [];
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Log an error into the ring buffer.
 * @param source  Origin identifier, e.g. 'background:extractAndIndex'.
 * @param err  The caught error or message string.
 */
function log(source: string, err: Error | string | unknown): void {
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

/**
 * Flush the current ring buffer to chrome.storage.local.
 * Fails silently to avoid infinite recursion if storage itself is broken.
 */
async function persist(): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: _buffer.slice() });
  } catch (_) {
    // Avoid infinite recursion — storage write itself failed
  }
}

/**
 * Restore the error ring buffer from chrome.storage.local on startup.
 * Populates the in-memory buffer with the most recent MAX_ENTRIES entries.
 * Fails silently if storage is empty or unreadable.
 */
async function load(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored: unknown = result[STORAGE_KEY];
    if (Array.isArray(stored)) {
      _buffer.length = 0;
      const start = Math.max(0, stored.length - MAX_ENTRIES);
      for (let i = start; i < stored.length; i++) {
        _buffer.push(stored[i] as ErrorLogEntry);
      }
    }
  } catch (_) {
    // Storage read failed — start with empty buffer
  }
}

/**
 * Get a shallow copy of all error entries currently in the ring buffer.
 * Entries are ordered chronologically (oldest first).
 */
function getAll(): ErrorLogEntry[] {
  return _buffer.slice();
}

/**
 * Clear all error entries from both the in-memory buffer and chrome.storage.local.
 * Best-effort — storage removal failures are silently ignored.
 */
async function clear(): Promise<void> {
  _buffer.length = 0;
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch (_) {
    // Ignore — clearing is best-effort
  }
}

/**
 * Schedule a debounced persist to storage. Only one persist can be
 * pending at a time — subsequent calls within PERSIST_DEBOUNCE_MS are no-ops.
 */
function _schedulePersist(): void {
  if (_persistTimer !== null) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    persist();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Group error entries by source category (the part before the first colon).
 * @returns Map of category name → count.
 */
function getCategories(): Record<string, number> {
  const cats: Record<string, number> = {};
  for (const entry of _buffer) {
    const cat = (entry.source || 'unknown').split(':')[0];
    cats[cat] = (cats[cat] || 0) + 1;
  }
  return cats;
}

export class ErrorLogger {
  readonly log = log;
  readonly persist = persist;
  readonly load = load;
  readonly getAll = getAll;
  readonly clear = clear;
  readonly getCategories = getCategories;
}

export const errorLogger = new ErrorLogger();
