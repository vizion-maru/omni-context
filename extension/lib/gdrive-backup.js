import { errorLogger } from './error-logger.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPES = ['https://www.googleapis.com/auth/drive.appdata'];
const BACKUP_MIME_TYPE = 'application/json';
const BACKUP_FILENAME_PREFIX = 'omni-context-backup-';

// ── OAuth helpers ──────────────────────────────────────────────────────────────

/**
 * Acquire an OAuth2 access token using chrome.identity.
 * Uses interactive mode on first call; subsequent calls use cached token.
 * @param {boolean} [interactive=true] Whether to show a consent prompt.
 * @returns {Promise<string|null>} Access token or null on failure.
 */
async function getAuthToken(interactive = true) {
  try {
    const token = await chrome.identity.getAuthToken({ interactive, scopes: SCOPES });
    // MV3 returns { token } object; MV2 returns string directly
    return typeof token === 'object' ? token.token : token;
  } catch (err) {
    errorLogger.log('gdrive:getAuthToken', err);
    return null;
  }
}

/**
 * Remove the cached OAuth token (used on 401 to force re-auth).
 * @param {string} token  Token to revoke from cache.
 * @returns {Promise<void>}
 */
async function removeCachedToken(token) {
  try {
    await chrome.identity.removeCachedAuthToken({ token });
  } catch (err) {
    errorLogger.log('gdrive:removeCachedToken', err);
  }
}

// ── Encryption ─────────────────────────────────────────────────────────────────

/**
 * Derive an AES-GCM key from a passphrase using PBKDF2.
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {string[]} usages  Key usage: ['encrypt'] or ['decrypt'].
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(passphrase, salt, usages) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

/**
 * Encrypt plaintext using AES-GCM with a PBKDF2-derived key.
 * @param {string} plaintext  Data to encrypt.
 * @param {string} passphrase  User-provided passphrase.
 * @returns {Promise<{salt: string, iv: string, ciphertext: string}>}
 */
async function encrypt(plaintext, passphrase) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ['encrypt']);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(plaintext)
  );

  return {
    salt: bufToBase64(salt),
    iv: bufToBase64(iv),
    ciphertext: bufToBase64(new Uint8Array(cipherBuffer))
  };
}

/**
 * Decrypt ciphertext using AES-GCM with a PBKDF2-derived key.
 * @param {{salt: string, iv: string, ciphertext: string}} encrypted
 * @param {string} passphrase
 * @returns {Promise<string>}
 */
async function decrypt(encrypted, passphrase) {
  const salt = base64ToBuf(encrypted.salt);
  const iv = base64ToBuf(encrypted.iv);
  const ciphertext = base64ToBuf(encrypted.ciphertext);
  const key = await deriveKey(passphrase, salt, ['decrypt']);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, ciphertext
  );
  return new TextDecoder().decode(plainBuffer);
}

/**
 * Convert a Uint8Array to base64.
 * @param {Uint8Array} buf
 * @returns {string}
 */
function bufToBase64(buf) {
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    const chunk = buf.subarray(i, Math.min(i + CHUNK, buf.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string to Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBuf(b64) {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

// ── Input validation ───────────────────────────────────────────────────────────

/**
 * Validate that a Google Drive file ID matches the expected format.
 * Drive file IDs are alphanumeric strings with hyphens and underscores,
 * typically 28-44 characters. Rejects IDs containing path separators,
 * query strings, or other URL-special characters that could alter fetch URLs.
 * @param {string} fileId  File ID to validate.
 * @returns {boolean} True if the ID matches the safe pattern.
 */
function isValidDriveFileId(fileId) {
  return typeof fileId === 'string' && /^[a-zA-Z0-9_-]{10,128}$/.test(fileId);
}

// ── Drive API calls ────────────────────────────────────────────────────────────

/**
 * Upload encrypted history to Google Drive appDataFolder.
 * Creates a new backup file with timestamped name.
 * @param {string} passphrase  Encryption passphrase.
 * @returns {Promise<{ok: boolean, fileId?: string, error?: string}>}
 */
export async function exportToGDrive(passphrase) {
  if (!passphrase) return { ok: false, error: 'Passphrase required' };

  const token = await getAuthToken(true);
  if (!token) return { ok: false, error: 'Google sign-in failed or was cancelled' };

  try {
    // Gather history from local storage
    const stored = await chrome.storage.local.get(['historyIds']);
    const ids = stored.historyIds || [];
    if (ids.length === 0) return { ok: false, error: 'No history to back up' };

    const data = await chrome.storage.local.get(ids.map(id => `hist_${id}`));
    const sessions = ids.map(id => data[`hist_${id}`]).filter(Boolean);

    const plaintext = JSON.stringify({ version: 1, exportedAt: Date.now(), sessions });
    const encrypted = await encrypt(plaintext, passphrase);

    // Multipart upload to appDataFolder
    const filename = BACKUP_FILENAME_PREFIX + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.json';
    const metadata = {
      name: filename,
      mimeType: BACKUP_MIME_TYPE,
      parents: ['appDataFolder']
    };

    const boundary = '---omni_context_boundary_' + Date.now();
    const body = [
      `--${boundary}\r\n`,
      'Content-Type: application/json; charset=UTF-8\r\n\r\n',
      JSON.stringify(metadata) + '\r\n',
      `--${boundary}\r\n`,
      `Content-Type: ${BACKUP_MIME_TYPE}\r\n\r\n`,
      JSON.stringify(encrypted) + '\r\n',
      `--${boundary}--`
    ].join('');

    const response = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    });

    if (response.status === 401) {
      await removeCachedToken(token);
      return { ok: false, error: 'Auth expired — please try again' };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      errorLogger.log('gdrive:export', `HTTP ${response.status}: ${errText.slice(0, 200)}`);
      return { ok: false, error: `Upload failed (HTTP ${response.status})` };
    }

    const result = await response.json();
    return { ok: true, fileId: result.id };
  } catch (err) {
    errorLogger.log('gdrive:export', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Download and decrypt a backup from Google Drive.
 * @param {string} fileId  Drive file ID to restore.
 * @param {string} passphrase  Decryption passphrase.
 * @returns {Promise<{ok: boolean, imported?: number, error?: string}>}
 */
export async function importFromGDrive(fileId, passphrase) {
  if (!fileId || !passphrase) return { ok: false, error: 'Missing file ID or passphrase' };
  if (!isValidDriveFileId(fileId)) return { ok: false, error: 'Invalid file ID format' };

  const token = await getAuthToken(true);
  if (!token) return { ok: false, error: 'Google sign-in failed or was cancelled' };

  try {
    const response = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.status === 401) {
      await removeCachedToken(token);
      return { ok: false, error: 'Auth expired — please try again' };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      errorLogger.log('gdrive:import', `HTTP ${response.status}: ${errText.slice(0, 200)}`);
      return { ok: false, error: `Download failed (HTTP ${response.status})` };
    }

    const encrypted = await response.json();
    const plaintext = await decrypt(encrypted, passphrase);
    const data = JSON.parse(plaintext);

    if (data.version !== 1 || !Array.isArray(data.sessions)) {
      return { ok: false, error: 'Invalid backup format' };
    }

    // Merge sessions into local storage (skip duplicates)
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
    errorLogger.log('gdrive:import', err);
    return { ok: false, error: err.message };
  }
}

/**
 * List available backups in Google Drive appDataFolder.
 * @returns {Promise<{ok: boolean, backups?: Array<{id: string, name: string, createdTime: string, size: number}>, error?: string}>}
 */
export async function listBackups() {
  const token = await getAuthToken(true);
  if (!token) return { ok: false, error: 'Google sign-in failed or was cancelled' };

  try {
    const query = encodeURIComponent(`name contains '${BACKUP_FILENAME_PREFIX}' and trashed = false`);
    const fields = encodeURIComponent('files(id,name,createdTime,size)');
    const url = `${DRIVE_FILES_URL}?spaces=appDataFolder&q=${query}&fields=${fields}&orderBy=createdTime desc&pageSize=20`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.status === 401) {
      await removeCachedToken(token);
      return { ok: false, error: 'Auth expired — please try again' };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      errorLogger.log('gdrive:listBackups', `HTTP ${response.status}: ${errText.slice(0, 200)}`);
      return { ok: false, error: `List failed (HTTP ${response.status})` };
    }

    const result = await response.json();
    const backups = (result.files || []).map(f => ({
      id: f.id,
      name: f.name,
      createdTime: f.createdTime,
      size: parseInt(f.size, 10) || 0
    }));

    return { ok: true, backups };
  } catch (err) {
    errorLogger.log('gdrive:listBackups', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Delete a backup file from Google Drive.
 * @param {string} fileId  Drive file ID to delete.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function deleteBackup(fileId) {
  if (!fileId) return { ok: false, error: 'Missing file ID' };
  if (!isValidDriveFileId(fileId)) return { ok: false, error: 'Invalid file ID format' };

  const token = await getAuthToken(true);
  if (!token) return { ok: false, error: 'Google sign-in failed or was cancelled' };

  try {
    const response = await fetch(`${DRIVE_FILES_URL}/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.status === 401) {
      await removeCachedToken(token);
      return { ok: false, error: 'Auth expired — please try again' };
    }

    if (!response.ok && response.status !== 204) {
      return { ok: false, error: `Delete failed (HTTP ${response.status})` };
    }

    return { ok: true };
  } catch (err) {
    errorLogger.log('gdrive:deleteBackup', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Disconnect Google Drive by revoking the cached auth token.
 * @returns {Promise<{ok: boolean}>}
 */
export async function disconnectGDrive() {
  try {
    const token = await getAuthToken(false);
    if (token) await removeCachedToken(token);
    return { ok: true };
  } catch (err) {
    errorLogger.log('gdrive:disconnect', err);
    return { ok: true }; // Non-critical — consider success
  }
}
