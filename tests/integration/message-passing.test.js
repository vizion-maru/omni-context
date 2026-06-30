import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { _store } from '../chrome-mock.js';

vi.mock('../../extension/lib/extpay.js', () => ({
  extpay: {
    onPaid: { addListener: vi.fn() },
    onTrialStarted: { addListener: vi.fn() },
    getUser: () => Promise.resolve({ paid: false }),
    startBackground: vi.fn(),
    openPaymentPage: vi.fn(),
    openTrialPage: vi.fn(),
  },
  DEFAULT_PLANS: { monthly: 'pro_monthly_399', annual: 'pro_yearly_29' },
  openPaymentPage: vi.fn(),
  openTrialPage: vi.fn(),
}));

let messageHandler;
let portHandler;

beforeAll(async () => {
  _store.provider = 'groq';
  _store.apiKey = 'gsk-test-key';
  _store.model = 'llama-3.3-70b-versatile';
  globalThis.fetch = vi.fn();

  await import('../../extension/background.js');

  const msgCalls = chrome.runtime.onMessage.addListener.mock.calls;
  messageHandler = msgCalls[msgCalls.length - 1][0];

  const connectCalls = chrome.runtime.onConnect.addListener.mock.calls;
  portHandler = connectCalls[connectCalls.length - 1][0];
});

function sendMessage(msg, sender = {}) {
  return new Promise((resolve) => {
    const returnVal = messageHandler(msg, sender, resolve);
    if (returnVal === false) resolve(undefined);
  });
}

function createMockPort(name = 'omni-chat') {
  const msgListeners = [];
  const messages = [];
  const port = {
    name,
    postMessage: vi.fn((msg) => messages.push(msg)),
    onMessage: { addListener: vi.fn((fn) => msgListeners.push(fn)) },
    onDisconnect: { addListener: vi.fn() },
    _messages: messages,
    async _fire(msg) {
      for (const fn of msgListeners) await fn(msg);
    },
  };
  return port;
}

describe('message-passing integration', () => {
  beforeEach(() => {
    _store.provider = 'groq';
    _store.apiKey = 'gsk-test-key';
    _store.model = 'llama-3.3-70b-versatile';
  });

  describe('TAB_CONTENT (from content script)', () => {
    it('indexes tab content when sent from a content script', async () => {
      const sender = { tab: { id: 42 } };
      const msg = { type: 'TAB_CONTENT', title: 'My Page', url: 'https://test.com', content: 'Hello world content here' };

      await sendMessage(msg, sender);

      const sizeResp = await sendMessage({ type: 'GET_INDEX_SIZE' });
      expect(sizeResp.count).toBeGreaterThanOrEqual(1);
    });

    it('ignores TAB_CONTENT without sender tab id', async () => {
      const sizeBefore = await sendMessage({ type: 'GET_INDEX_SIZE' });
      await sendMessage({ type: 'TAB_CONTENT', title: 'X', url: 'u', content: 'c' }, {});
      const sizeAfter = await sendMessage({ type: 'GET_INDEX_SIZE' });
      expect(sizeAfter.count).toBe(sizeBefore.count);
    });
  });

  describe('REINDEX_ALL', () => {
    it('triggers reindex and returns ok', async () => {
      chrome.tabs.query.mockResolvedValueOnce([
        { id: 99, url: 'https://reindex.test', title: 'Reindex', status: 'complete' },
      ]);
      chrome.scripting.executeScript.mockResolvedValueOnce([
        { result: { title: 'Reindex', content: 'reindexed content', url: 'https://reindex.test' } },
      ]);

      const resp = await sendMessage({ type: 'REINDEX_ALL' });
      expect(resp).toEqual({ ok: true });
    });
  });

  describe('GET_INDEX_SIZE', () => {
    it('returns object with numeric count', async () => {
      const resp = await sendMessage({ type: 'GET_INDEX_SIZE' });
      expect(resp).toHaveProperty('count');
      expect(typeof resp.count).toBe('number');
    });
  });

  describe('GET_SETTINGS', () => {
    it('returns provider, apiKey, and model from storage', async () => {
      const resp = await sendMessage({ type: 'GET_SETTINGS' });
      expect(resp.provider).toBe('groq');
      expect(resp.apiKey).toBe('gsk-test-key');
      expect(resp.model).toBe('llama-3.3-70b-versatile');
    });
  });

  describe('GET_DAILY_USAGE', () => {
    it('returns usage stats with cost estimate', async () => {
      const resp = await sendMessage({ type: 'GET_DAILY_USAGE' });
      expect(resp).toHaveProperty('input');
      expect(resp).toHaveProperty('output');
      expect(resp).toHaveProperty('queries');
      expect(resp).toHaveProperty('providers');
      expect(resp).toHaveProperty('cost');
      expect(resp.cost).toHaveProperty('total');
      expect(typeof resp.input).toBe('number');
    });

    it('returns zero values when no usage recorded', async () => {
      const resp = await sendMessage({ type: 'GET_DAILY_USAGE' });
      expect(resp.queries).toBe(0);
      expect(resp.input).toBe(0);
      expect(resp.output).toBe(0);
    });
  });

  describe('GET_WEEKLY_USAGE', () => {
    it('returns weekly aggregated usage with cost', async () => {
      const resp = await sendMessage({ type: 'GET_WEEKLY_USAGE' });
      expect(resp).toHaveProperty('input');
      expect(resp).toHaveProperty('output');
      expect(resp).toHaveProperty('cost');
      expect(resp.cost).toHaveProperty('total');
      expect(typeof resp.cost.total).toBe('number');
    });
  });

  describe('CHAT via port (streaming)', () => {
    it('sends ERROR when no API key configured', async () => {
      delete _store.apiKey;
      delete _store.provider;

      const port = createMockPort();
      portHandler(port);

      await port._fire({
        type: 'CHAT',
        messages: [{ role: 'user', content: 'hello' }],
        activeTabId: null,
        isResearch: false,
      });

      const errorMsg = port._messages.find(m => m.type === 'ERROR');
      expect(errorMsg).toBeDefined();
      expect(errorMsg.error).toContain('API key');
    });

    it('streams response chunks via port for valid config', async () => {
      const sseBody = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\ndata: {"choices":[{"delta":{"content":" world"}}]}\ndata: [DONE]\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const line of sseBody.split('\n')) {
            controller.enqueue(encoder.encode(line + '\n'));
          }
          controller.close();
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream });

      const port = createMockPort();
      portHandler(port);

      await port._fire({
        type: 'CHAT',
        messages: [{ role: 'user', content: 'test query' }],
        activeTabId: null,
        isResearch: false,
      });

      const chunks = port._messages.filter(m => m.type === 'CHUNK');
      expect(chunks.length).toBeGreaterThan(0);
      const text = chunks.map(c => c.text).join('');
      expect(text).toContain('Hello');
    });
  });

  describe('SEARCH_TABS via port', () => {
    it('returns scored results and domain list for matching query', async () => {
      const sender = { tab: { id: 500 } };
      await sendMessage({
        type: 'TAB_CONTENT',
        title: 'React Hooks Guide',
        url: 'https://react.dev/hooks',
        content: 'React hooks allow you to use state and lifecycle features in function components',
      }, sender);

      const port = createMockPort();
      portHandler(port);

      await port._fire({ type: 'SEARCH_TABS', query: 'react hooks', domain: '' });

      const result = port._messages.find(m => m.type === 'SEARCH_TABS_RESULT');
      expect(result).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]).toHaveProperty('tabId');
      expect(result.results[0]).toHaveProperty('title');
      expect(result.results[0]).toHaveProperty('score');
      expect(result.results[0]).toHaveProperty('snippet');
      expect(result.domains).toContain('react.dev');
    });
  });

  describe('COMPARE_TABS (via CHAT with compare prompt)', () => {
    it('includes both tab contents in system context sent to AI', async () => {
      await sendMessage({ type: 'TAB_CONTENT', title: 'React Docs', url: 'https://react.dev', content: 'React is a UI library for components' }, { tab: { id: 301 } });
      await sendMessage({ type: 'TAB_CONTENT', title: 'Vue Guide', url: 'https://vuejs.org', content: 'Vue is a progressive JavaScript framework' }, { tab: { id: 302 } });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Both are great"}}]}\ndata: [DONE]\n'));
            c.close();
          },
        }),
      });

      const port = createMockPort();
      portHandler(port);

      await port._fire({
        type: 'CHAT',
        messages: [{ role: 'user', content: 'Compare React Docs with Vue Guide' }],
        activeTabId: null,
        isResearch: false,
      });

      expect(globalThis.fetch).toHaveBeenCalled();
      const reqBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      const systemMsg = reqBody.messages.find(m => m.role === 'system');
      expect(systemMsg.content).toContain('React');
      expect(systemMsg.content).toContain('Vue');
    });
  });

  describe('GET_LAST_INDEXED', () => {
    it('returns a numeric timestamp via one-shot message', async () => {
      const resp = await sendMessage({ type: 'GET_LAST_INDEXED' });
      expect(resp).toHaveProperty('timestamp');
      expect(typeof resp.timestamp).toBe('number');
      expect(resp.timestamp).toBeGreaterThan(0);
    });
  });

  describe('RESET_USAGE', () => {
    it('returns ok:true', async () => {
      const resp = await sendMessage({ type: 'RESET_USAGE' });
      expect(resp).toEqual({ ok: true });
    });
  });
});
