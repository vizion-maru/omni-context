import { errorLogger } from './error-logger.js';

const SYNC_META_KEY = '_oc_sync_meta';
const SYNC_SETTINGS_KEY = '_oc_sync_settings';
const SYNC_HISTORY_PREFIX = '_oc_hist_';
const QUOTA_BYTES_PER_ITEM = 8192;
const MAX_ITEMS = 512;
const DEBOUNCE_MS = 3000;

/**
 * Cross-device sync manager for Omni-Context Pro.
 * Uses chrome.storage.sync for settings with timestamp-based conflict resolution.
 * Provides encrypted export/import for conversation history backup.
 */
export class SyncManager {
  constructor() {
    this._debounceTimer = null;
    this._enabled = false;
    this._lastSyncTime = 0;
  }

  /**
   * Initialize the sync manager — loads enabled state and last sync time.
   * @returns {Promise<void>}
   */
  async init() {
    try {
      const result = await chrome.storage.sync.get([SYNC_META_KEY]);
      const meta = result[SYNC_META_KEY] || {};
      this._enabled = meta.enabled === true;
      this._lastSyncTime = meta.lastSyncTime || 0;
    } catch (err) {
      errorLogger.log('sync:init', err);
    }
  }

  /** @returns {boolean} */
  get enabled() { return this._enabled; }

  /** @returns {number} Unix timestamp of last successful sync. */
  get lastSyncTime() { return this._lastSyncTime; }

  /**
   * Enable or disable cross-device sync.
   * When enabled, immediately pushes current settings to sync storage.
   * @param {boolean} value
   * @returns {Promise<void>}
   */
  async setEnabled(value) {
    this._enabled = value === true;
    await this._saveMeta();
    if (this._enabled) {
      await this.pushSettings();
    }
  }

  /**
   * Push local settings to chrome.storage.sync with a timestamp.
   * Respects QUOTA_BYTES_PER_ITEM limits by chunking if needed.
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async pushSettings() {
    if (!this._enabled) return { ok: false, error: 'Sync disabled' };

    try {
      const local = await chrome.storage.local.get([
        'provider', 'model', 'embeddingEndpoint', 'embeddingModel'
      ]);
      const sync = await chrome.storage.sync.get([
        'theme', 'excludedDomains', 'pinnedDomains',
        'customPromptText', 'customPromptMode', 'semanticSearchEnabled'
      ]);

      const payload = {
        timestamp: Date.now(),
        settings: {
          provider: local.provider || null,
          model: local.model || null,
          embeddingEndpoint: local.embeddingEndpoint || null,
          embeddingModel: local.embeddingModel || null,
          theme: sync.theme || 'system',
          excludedDomains: sync.excludedDomains || [],
          pinnedDomains: sync.pinnedDomains || [],
          customPromptText: sync.customPromptText || '',
          customPromptMode: sync.customPromptMode || 'suffix',
          semanticSearchEnabled: sync.semanticSearchEnabled || false
        }
      };

      const serialized = JSON.stringify(payload);
      if (serialized.length > QUOTA_BYTES_PER_ITEM) {
        return await this._pushSettingsChunked(payload);
      }

      await chrome.storage.sync.set({ [SYNC_SETTINGS_KEY]: payload });
      this._lastSyncTime = payload.timestamp;
      await this._saveMeta();
      return { ok: true };
    } catch (err) {
      errorLogger.log('sync:pushSettings', err);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Pull settings from chrome.storage.sync and apply locally.
   * Uses timestamp-based conflict resolution — remote wins if newer.
   * @returns {Promise<{ok: boolean, applied: boolean, error?: string}>}
   */
  async pullSettings() {
    if (!this._enabled) return { ok: false, applied: false, error: 'Sync disabled' };

    try {
      const result = await chrome.storage.sync.get([SYNC_SETTINGS_KEY, SYNC_SETTINGS_KEY + '_chunks']);
      let payload = result[SYNC_SETTINGS_KEY];

      if (!payload && result[SYNC_SETTINGS_KEY + '_chunks']) {
        payload = await this._pullSettingsChunked();
      }

      if (!payload?.timestamp || !payload?.settings) {
        return { ok: true, applied: false };
      }

      if (payload.timestamp <= this._lastSyncTime) {
        return { ok: true, applied: false };
      }

      const s = payload.settings;

      await chrome.storage.local.set({
        provider: s.provider,
        model: s.model,
        embeddingEndpoint: s.embeddingEndpoint,
        embeddingModel: s.embeddingModel
      });

      await chrome.storage.sync.set({
        theme: s.theme,
        excludedDomains: s.excludedDomains,
        pinnedDomains: s.pinnedDomains,
        customPromptText: s.customPromptText,
        customPromptMode: s.customPromptMode,
        semanticSearchEnabled: s.semanticSearchEnabled
      });

      this._lastSyncTime = payload.timestamp;
      await this._saveMeta();
      return { ok: true, applied: true };
    } catch (err) {
      errorLogger.log('sync:pullSettings', err);
      return { ok: false, applied: false, error: err.message };
    }
  }

  /**
   * Schedule a debounced push of settings (called on settings change).
   */
  schedulePush() {
    if (!this._enabled) return;
    if (this._debounceTimer !== null) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.pushSettings();
    }, DEBOUNCE_MS);
  }

  /**
   * Export conversation history as an encrypted JSON blob.
   * Uses AES-GCM with a user-provided passphrase via PBKDF2.
   * @param {string} passphrase  User-chosen encryption passphrase.
   * @returns {Promise<{ok: boolean, blob?: Blob, error?: string}>}
   */
  async exportHistory(passphrase) {
    if (!passphrase) return { ok: false, error: 'Passphrase required' };

    try {
      const stored = await chrome.storage.local.get(['historyIds']);
      const ids = stored.historyIds || [];
      if (ids.length === 0) return { ok: false, error: 'No history to export' };

      const data = await chrome.storage.local.get(ids.map(id => `hist_${id}`));
      const sessions = ids.map(id => data[`hist_${id}`]).filter(Boolean);

      const plaintext = JSON.stringify({ version: 1, exportedAt: Date.now(), sessions });
      const encrypted = await this._encrypt(plaintext, passphrase);

      const blob = new Blob([JSON.stringify(encrypted)], { type: 'application/json' });
      return { ok: true, blob };
    } catch (err) {
      errorLogger.log('sync:exportHistory', err);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Import conversation history from an encrypted JSON blob.
   * Decrypts with the user-provided passphrase and merges into local storage.
   * @param {string} jsonString  The encrypted export JSON string.
   * @param {string} passphrase  The passphrase used during export.
   * @returns {Promise<{ok: boolean, imported?: number, error?: string}>}
   */
  async importHistory(jsonString, passphrase) {
    if (!passphrase || !jsonString) return { ok: false, error: 'Missing input' };

    try {
      const encrypted = JSON.parse(jsonString);
      const plaintext = await this._decrypt(encrypted, passphrase);
      const data = JSON.parse(plaintext);

      if (data.version !== 1 || !Array.isArray(data.sessions)) {
        return { ok: false, error: 'Invalid export format' };
      }

      const stored = await chrome.storage.local.get(['historyIds']);
      const existingIds = new Set(stored.historyIds || []);
      const newSessions = data.sessions.filter(s => s.id && !existingIds.has(s.id));

      if (newSessions.length === 0) return { ok: true, imported: 0 };

      const updates = {};
      const newIds = [];
      for (const session of newSessions) {
        updates[`hist_${session.id}`] = session;
        newIds.push(session.id);
      }

      const mergedIds = [...newIds, ...(stored.historyIds || [])];
      updates.historyIds = mergedIds.slice(0, 200);

      await chrome.storage.local.set(updates);
      return { ok: true, imported: newSessions.length };
    } catch (err) {
      if (err.name === 'OperationError') {
        return { ok: false, error: 'Decryption failed — wrong passphrase?' };
      }
      errorLogger.log('sync:importHistory', err);
      return { ok: false, error: err.message };
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  async _saveMeta() {
    try {
      await chrome.storage.sync.set({
        [SYNC_META_KEY]: { enabled: this._enabled, lastSyncTime: this._lastSyncTime }
      });
    } catch (err) {
      errorLogger.log('sync:saveMeta', err);
    }
  }

  /**
   * Split an oversized settings payload into chunks and save to chrome.storage.sync.
   * Each chunk stays within QUOTA_BYTES_PER_ITEM. Limited to 10 chunks max to stay
   * well within chrome.storage.sync's MAX_ITEMS quota.
   * @param {Object} payload  The settings payload object with timestamp and settings.
   * @returns {Promise<{ok: boolean, error?: string}>}
   * @private
   */
  async _pushSettingsChunked(payload) {
    const str = JSON.stringify(payload);
    const chunkSize = QUOTA_BYTES_PER_ITEM - 100;
    const chunks = [];
    for (let i = 0; i < str.length; i += chunkSize) {
      chunks.push(str.slice(i, i + chunkSize));
    }

    if (chunks.length > 10) {
      return { ok: false, error: 'Settings too large to sync' };
    }

    const updates = { [SYNC_SETTINGS_KEY + '_chunks']: chunks.length };
    for (let i = 0; i < chunks.length; i++) {
      updates[SYNC_SETTINGS_KEY + '_c' + i] = chunks[i];
    }
    await chrome.storage.sync.set(updates);
    this._lastSyncTime = payload.timestamp;
    await this._saveMeta();
    return { ok: true };
  }

  /**
   * Reassemble chunked settings from chrome.storage.sync.
   * Used when the settings payload exceeds QUOTA_BYTES_PER_ITEM and was
   * split across multiple keys during push. Logs corruption errors to
   * the error ring buffer for debugging instead of silently discarding.
   * @returns {Promise<Object|null>} Parsed settings payload, or null if chunks are missing/corrupt.
   * @private
   */
  async _pullSettingsChunked() {
    const MAX_CHUNKS = 10; // Must match _pushSettingsChunked limit
    const meta = await chrome.storage.sync.get(SYNC_SETTINGS_KEY + '_chunks');
    const count = meta[SYNC_SETTINGS_KEY + '_chunks'];
    if (!count || count < 1) return null;
    if (!Number.isInteger(count) || count > MAX_CHUNKS) {
      errorLogger.log('sync:pullSettingsChunked', `Invalid chunk count: ${count} (max ${MAX_CHUNKS})`);
      return null;
    }

    const keys = [];
    for (let i = 0; i < count; i++) {
      keys.push(SYNC_SETTINGS_KEY + '_c' + i);
    }
    const chunks = await chrome.storage.sync.get(keys);
    let assembled = '';
    for (let i = 0; i < count; i++) {
      const chunk = chunks[SYNC_SETTINGS_KEY + '_c' + i];
      if (!chunk) return null;
      assembled += chunk;
    }
    try {
      return JSON.parse(assembled);
    } catch (parseErr) {
      errorLogger.log('sync:pullSettingsChunked', `Corrupted chunked sync data (${count} chunks, ${assembled.length} chars): ${parseErr.message}`);
      return null;
    }
  }

  /**
   * Encrypt plaintext using AES-GCM with PBKDF2-derived key.
   * @param {string} plaintext
   * @param {string} passphrase
   * @returns {Promise<{salt: string, iv: string, ciphertext: string}>}
   */
  async _encrypt(plaintext, passphrase) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(plaintext)
    );

    return {
      salt: this._bufToBase64(salt),
      iv: this._bufToBase64(iv),
      ciphertext: this._bufToBase64(new Uint8Array(ciphertext))
    };
  }

  /**
   * Decrypt ciphertext using AES-GCM with PBKDF2-derived key.
   * @param {{salt: string, iv: string, ciphertext: string}} encrypted
   * @param {string} passphrase
   * @returns {Promise<string>}
   */
  async _decrypt(encrypted, passphrase) {
    const enc = new TextEncoder();
    const salt = this._base64ToBuf(encrypted.salt);
    const iv = this._base64ToBuf(encrypted.iv);
    const ciphertext = this._base64ToBuf(encrypted.ciphertext);

    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    return new TextDecoder().decode(plainBuffer);
  }

  /**
   * Convert a Uint8Array to a base64 string.
   * Uses chunked processing to avoid RangeError from spread operator
   * on large buffers (>65K bytes), which can occur with encrypted history exports.
   * @param {Uint8Array} buf  Binary data to encode.
   * @returns {string} Base64-encoded string.
   */
  _bufToBase64(buf) {
    // Process in chunks of 8192 to avoid max argument count limit in String.fromCharCode
    const CHUNK_SIZE = 8192;
    let binary = '';
    for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
      const chunk = buf.subarray(i, Math.min(i + CHUNK_SIZE, buf.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  /**
   * Decode a base64 string back into a Uint8Array.
   * @param {string} b64  Base64-encoded string to decode.
   * @returns {Uint8Array} Decoded binary data.
   */
  _base64ToBuf(b64) {
    const binary = atob(b64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return buf;
  }
}
