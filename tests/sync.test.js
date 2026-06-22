import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _store } from './chrome-mock.js';
import { SyncManager } from '../extension/lib/sync.js';

const _syncStore = {};

function setupSyncStoreMock() {
  chrome.storage.sync.get.mockImplementation(async (keys) => {
    if (typeof keys === 'string') return { [keys]: _syncStore[keys] };
    const arr = Array.isArray(keys) ? keys : Object.keys(keys || {});
    const result = {};
    for (const k of arr) {
      if (k in _syncStore) result[k] = _syncStore[k];
    }
    return result;
  });
  chrome.storage.sync.set.mockImplementation(async (items) => {
    Object.assign(_syncStore, items);
  });
}

describe('SyncManager', () => {
  let sm;

  beforeEach(() => {
    for (const key of Object.keys(_syncStore)) delete _syncStore[key];
    setupSyncStoreMock();
    sm = new SyncManager();
  });

  describe('init', () => {
    it('starts disabled with lastSyncTime 0', async () => {
      await sm.init();
      expect(sm.enabled).toBe(false);
      expect(sm.lastSyncTime).toBe(0);
    });

    it('restores enabled state from sync storage', async () => {
      _syncStore['_oc_sync_meta'] = { enabled: true, lastSyncTime: 12345 };
      await sm.init();
      expect(sm.enabled).toBe(true);
      expect(sm.lastSyncTime).toBe(12345);
    });

    it('handles storage errors gracefully', async () => {
      chrome.storage.sync.get.mockRejectedValueOnce(new Error('quota'));
      await sm.init();
      expect(sm.enabled).toBe(false);
    });
  });

  describe('setEnabled', () => {
    it('enables sync and persists meta', async () => {
      _store.provider = 'openai';
      _store.model = 'gpt-4';
      await sm.setEnabled(true);
      expect(sm.enabled).toBe(true);
      expect(_syncStore['_oc_sync_meta'].enabled).toBe(true);
    });

    it('disables sync and persists meta', async () => {
      await sm.setEnabled(true);
      await sm.setEnabled(false);
      expect(sm.enabled).toBe(false);
      expect(_syncStore['_oc_sync_meta'].enabled).toBe(false);
    });

    it('pushes settings immediately when enabling', async () => {
      _store.provider = 'openai';
      _store.model = 'gpt-4o';
      await sm.setEnabled(true);
      expect(_syncStore['_oc_sync_settings']).toBeDefined();
      expect(_syncStore['_oc_sync_settings'].settings.provider).toBe('openai');
    });
  });

  describe('pushSettings', () => {
    it('returns error when sync is disabled', async () => {
      const result = await sm.pushSettings();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('pushes local and sync settings with timestamp', async () => {
      _store.provider = 'anthropic';
      _store.model = 'claude-3';
      _store.embeddingEndpoint = 'https://embed.test';
      _store.embeddingModel = 'embed-v1';
      _syncStore.theme = 'dark';
      _syncStore.excludedDomains = ['*.ads.com'];
      _syncStore.pinnedDomains = ['docs.dev'];
      _syncStore.customPromptText = 'Be concise';
      _syncStore.customPromptMode = 'prefix';
      _syncStore.semanticSearchEnabled = true;

      await sm.setEnabled(true);
      const payload = _syncStore['_oc_sync_settings'];

      expect(payload.timestamp).toBeTypeOf('number');
      expect(payload.settings.provider).toBe('anthropic');
      expect(payload.settings.model).toBe('claude-3');
      expect(payload.settings.embeddingEndpoint).toBe('https://embed.test');
      expect(payload.settings.embeddingModel).toBe('embed-v1');
      expect(payload.settings.theme).toBe('dark');
      expect(payload.settings.excludedDomains).toEqual(['*.ads.com']);
      expect(payload.settings.pinnedDomains).toEqual(['docs.dev']);
      expect(payload.settings.customPromptText).toBe('Be concise');
      expect(payload.settings.customPromptMode).toBe('prefix');
      expect(payload.settings.semanticSearchEnabled).toBe(true);
    });

    it('updates lastSyncTime after successful push', async () => {
      await sm.setEnabled(true);
      expect(sm.lastSyncTime).toBeGreaterThan(0);
    });

    it('handles storage write error', async () => {
      sm._enabled = true;
      chrome.storage.sync.set.mockRejectedValueOnce(new Error('QUOTA_EXCEEDED'));
      const result = await sm.pushSettings();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('QUOTA_EXCEEDED');
    });
  });

  describe('pullSettings', () => {
    it('returns error when sync is disabled', async () => {
      const result = await sm.pullSettings();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('returns applied=false when no payload exists', async () => {
      sm._enabled = true;
      const result = await sm.pullSettings();
      expect(result.ok).toBe(true);
      expect(result.applied).toBe(false);
    });

    it('applies remote settings when timestamp is newer', async () => {
      sm._enabled = true;
      sm._lastSyncTime = 1000;

      _syncStore['_oc_sync_settings'] = {
        timestamp: 2000,
        settings: {
          provider: 'groq',
          model: 'llama-3',
          embeddingEndpoint: null,
          embeddingModel: null,
          theme: 'light',
          excludedDomains: ['*.spam.com'],
          pinnedDomains: [],
          customPromptText: '',
          customPromptMode: 'suffix',
          semanticSearchEnabled: false,
        },
      };

      const result = await sm.pullSettings();
      expect(result.ok).toBe(true);
      expect(result.applied).toBe(true);
      expect(_store.provider).toBe('groq');
      expect(_store.model).toBe('llama-3');
      expect(_syncStore.theme).toBe('light');
      expect(_syncStore.excludedDomains).toEqual(['*.spam.com']);
    });

    it('skips apply when remote timestamp is older', async () => {
      sm._enabled = true;
      sm._lastSyncTime = 5000;

      _syncStore['_oc_sync_settings'] = {
        timestamp: 3000,
        settings: { provider: 'should-not-apply', model: 'x' },
      };

      const result = await sm.pullSettings();
      expect(result.ok).toBe(true);
      expect(result.applied).toBe(false);
      expect(_store.provider).toBeUndefined();
    });

    it('skips apply when timestamps are equal', async () => {
      sm._enabled = true;
      sm._lastSyncTime = 5000;

      _syncStore['_oc_sync_settings'] = {
        timestamp: 5000,
        settings: { provider: 'nope', model: 'x' },
      };

      const result = await sm.pullSettings();
      expect(result.applied).toBe(false);
    });

    it('updates lastSyncTime after successful apply', async () => {
      sm._enabled = true;
      sm._lastSyncTime = 0;

      _syncStore['_oc_sync_settings'] = {
        timestamp: 9999,
        settings: {
          provider: 'x', model: 'y',
          embeddingEndpoint: null, embeddingModel: null,
          theme: 'system', excludedDomains: [], pinnedDomains: [],
          customPromptText: '', customPromptMode: 'suffix',
          semanticSearchEnabled: false,
        },
      };

      await sm.pullSettings();
      expect(sm.lastSyncTime).toBe(9999);
    });
  });

  describe('schedulePush', () => {
    it('does nothing when disabled', () => {
      sm._enabled = false;
      sm.schedulePush();
      expect(sm._debounceTimer).toBeNull();
    });

    it('sets a debounce timer when enabled', () => {
      sm._enabled = true;
      sm.schedulePush();
      expect(sm._debounceTimer).not.toBeNull();
      clearTimeout(sm._debounceTimer);
      sm._debounceTimer = null;
    });
  });

  describe('exportHistory / importHistory round-trip', () => {
    it('encrypts and decrypts history correctly', async () => {
      const sessions = [
        { id: 'sess-1', messages: [{ role: 'user', content: 'hello' }] },
        { id: 'sess-2', messages: [{ role: 'assistant', content: 'hi' }] },
      ];
      _store.historyIds = ['sess-1', 'sess-2'];
      _store['hist_sess-1'] = sessions[0];
      _store['hist_sess-2'] = sessions[1];

      const exportResult = await sm.exportHistory('my-secret-pass');
      expect(exportResult.ok).toBe(true);
      expect(exportResult.blob).toBeInstanceOf(Blob);

      delete _store.historyIds;
      delete _store['hist_sess-1'];
      delete _store['hist_sess-2'];

      const jsonString = await exportResult.blob.text();
      const importResult = await sm.importHistory(jsonString, 'my-secret-pass');
      expect(importResult.ok).toBe(true);
      expect(importResult.imported).toBe(2);

      expect(_store.historyIds).toContain('sess-1');
      expect(_store.historyIds).toContain('sess-2');
      expect(_store['hist_sess-1']).toEqual(sessions[0]);
      expect(_store['hist_sess-2']).toEqual(sessions[1]);
    });

    it('returns error with wrong passphrase', async () => {
      _store.historyIds = ['s1'];
      _store['hist_s1'] = { id: 's1', messages: [] };

      const exportResult = await sm.exportHistory('correct-pass');
      const jsonString = await exportResult.blob.text();

      const importResult = await sm.importHistory(jsonString, 'wrong-pass');
      expect(importResult.ok).toBe(false);
      expect(importResult.error).toContain('passphrase');
    });

    it('exportHistory returns error without passphrase', async () => {
      const result = await sm.exportHistory('');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Passphrase');
    });

    it('exportHistory returns error when no history exists', async () => {
      const result = await sm.exportHistory('pass');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('No history');
    });

    it('importHistory returns error without input', async () => {
      const result = await sm.importHistory('', 'pass');
      expect(result.ok).toBe(false);
    });

    it('import skips sessions that already exist locally', async () => {
      _store.historyIds = ['s1'];
      _store['hist_s1'] = { id: 's1', messages: [{ role: 'user', content: 'original' }] };

      const exportData = {
        version: 1,
        exportedAt: Date.now(),
        sessions: [
          { id: 's1', messages: [{ role: 'user', content: 'duplicate' }] },
          { id: 's2', messages: [{ role: 'user', content: 'new' }] },
        ],
      };

      const encrypted = await sm._encrypt(JSON.stringify(exportData), 'pw');
      const jsonString = JSON.stringify(encrypted);

      const result = await sm.importHistory(jsonString, 'pw');
      expect(result.ok).toBe(true);
      expect(result.imported).toBe(1);
      expect(_store['hist_s1'].messages[0].content).toBe('original');
      expect(_store['hist_s2'].messages[0].content).toBe('new');
    });
  });
});
