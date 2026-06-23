import { vi, beforeEach } from 'vitest';

const _store = {};
const _syncStore = {};

const chrome = {
  storage: {
    local: {
      get: vi.fn(async (keys) => {
        if (typeof keys === 'string') return { [keys]: _store[keys] };
        const result = {};
        const arr = Array.isArray(keys) ? keys : Object.keys(keys || {});
        for (const k of arr) {
          if (k in _store) result[k] = _store[k];
        }
        return result;
      }),
      set: vi.fn(async (items) => {
        Object.assign(_store, items);
      }),
      remove: vi.fn(async (keys) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete _store[k];
      }),
    },
    sync: {
      get: vi.fn(async (keys) => {
        if (!keys) return { ..._syncStore };
        if (typeof keys === 'string') return { [keys]: _syncStore[keys] };
        const arr = Array.isArray(keys) ? keys : Object.keys(keys || {});
        const result = {};
        for (const k of arr) {
          if (k in _syncStore) result[k] = _syncStore[k];
        }
        return result;
      }),
      set: vi.fn(async (items) => {
        Object.assign(_syncStore, items);
      }),
    },
    session: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
    onChanged: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(async () => []),
    get: vi.fn(async (id) => ({ id, url: `https://example.com/${id}`, title: `Tab ${id}` })),
    onUpdated: { addListener: vi.fn() },
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabGroups: {
    query: vi.fn(async () => []),
  },
  runtime: {
    sendMessage: vi.fn(async () => ({})),
    getManifest: vi.fn(() => ({ version: '1.0.0' })),
    getURL: vi.fn((path) => `chrome-extension://fake-id/${path}`),
    id: 'fake-extension-id',
    onStartup: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
    onConnect: { addListener: vi.fn() },
    lastError: null,
  },
  action: {
    onClicked: { addListener: vi.fn() },
  },
  sidePanel: {
    open: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(async () => [{ result: null }]),
  },
  identity: {
    getRedirectURL: vi.fn(() => 'https://redirect.test'),
  },
  i18n: {
    getMessage: vi.fn((key) => key),
  },
};

globalThis.chrome = chrome;

beforeEach(() => {
  for (const key of Object.keys(_store)) delete _store[key];
  for (const key of Object.keys(_syncStore)) delete _syncStore[key];
  vi.clearAllMocks();

  chrome.storage.local.get.mockImplementation(async (keys) => {
    if (typeof keys === 'string') return { [keys]: _store[keys] };
    const result = {};
    const arr = Array.isArray(keys) ? keys : Object.keys(keys || {});
    for (const k of arr) {
      if (k in _store) result[k] = _store[k];
    }
    return result;
  });
  chrome.storage.local.set.mockImplementation(async (items) => {
    Object.assign(_store, items);
  });
  chrome.storage.local.remove.mockImplementation(async (keys) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete _store[k];
  });
  chrome.storage.sync.get.mockImplementation(async (keys) => {
    if (!keys) return { ..._syncStore };
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
  chrome.storage.session.get.mockImplementation(async () => ({}));
  chrome.storage.session.set.mockImplementation(async () => {});
  chrome.tabs.query.mockImplementation(async () => []);
  chrome.tabGroups.query.mockImplementation(async () => []);
  chrome.i18n.getMessage.mockImplementation((key) => key);
  chrome.runtime.getManifest.mockImplementation(() => ({ version: '1.0.0' }));
});

export { chrome, _store, _syncStore };
