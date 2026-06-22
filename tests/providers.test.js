import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProvider, testProvider } from '../extension/lib/providers.js';

function mockFetchResponse(status, body, stream = false) {
  if (stream) {
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        const lines = body.split('\n');
        for (const line of lines) {
          controller.enqueue(encoder.encode(line + '\n'));
        }
        controller.close();
      }
    });
    return { ok: status >= 200 && status < 300, status, body: readable, text: async () => body };
  }
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

describe('providers', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  describe('createProvider', () => {
    it('returns provider with test and streamChat methods for known providers', () => {
      const providers = ['openai', 'anthropic', 'gemini', 'groq', 'mistral', 'deepseek', 'xai', 'openrouter', 'perplexity', 'cohere'];
      for (const name of providers) {
        const p = createProvider({ provider: name, apiKey: 'sk-test' });
        expect(typeof p.test).toBe('function');
        expect(typeof p.streamChat).toBe('function');
      }
    });

    it('throws for unknown provider', () => {
      expect(() => createProvider({ provider: 'nonexistent', apiKey: 'key' })).toThrow('Unknown provider: nonexistent');
    });

    it('defaults to openai when oauthProvider is openai and no provider set', () => {
      const p = createProvider({ oauthProvider: 'openai', oauthAccessToken: 'oauth-token' });
      expect(p.constructor.name).toBe('OpenAIProvider');
    });

    it('uses OAuth token over apiKey for openai provider', () => {
      const p = createProvider({ provider: 'openai', apiKey: 'sk-key', oauthProvider: 'openai', oauthAccessToken: 'oauth-tok' });
      expect(p.apiKey).toBe('oauth-tok');
    });
  });

  describe('testProvider', () => {
    it('returns ok:true when API responds 200', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(200, '{"data":[]}'));
      const result = await testProvider({ provider: 'openai', apiKey: 'sk-valid' });
      expect(result.ok).toBe(true);
    });

    it('returns ok:false with error for 401', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(401, ''));
      const result = await testProvider({ provider: 'openai', apiKey: 'sk-invalid' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Invalid API key/);
    });

    it('returns network error on fetch failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('net::ERR_FAILED'));
      const result = await testProvider({ provider: 'groq', apiKey: 'key' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Network error/);
    });
  });

  describe('system prompt construction (via streamChat)', () => {
    it('includes context string in prompt sent to API', async () => {
      let capturedBody;
      globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse(200, 'data: [DONE]\n', true);
      });

      const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
      await provider.streamChat(
        [{ role: 'user', content: 'hello' }],
        'Tab content here',
        false,
        () => {},
        {}
      );

      const systemMsg = capturedBody.messages[0];
      expect(systemMsg.role).toBe('system');
      expect(systemMsg.content).toContain('Tab content here');
      expect(systemMsg.content).toContain('Omni-Context');
    });

    it('uses research prompt when isResearch=true', async () => {
      let capturedBody;
      globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse(200, 'data: [DONE]\n', true);
      });

      const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
      await provider.streamChat(
        [{ role: 'user', content: 'analyze' }],
        'Context data',
        true,
        () => {},
        {}
      );

      expect(capturedBody.messages[0].content).toContain('RESEARCH MODE');
    });

    it('applies custom prompt with suffix mode', async () => {
      let capturedBody;
      globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse(200, 'data: [DONE]\n', true);
      });

      const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
      await provider.streamChat(
        [{ role: 'user', content: 'test' }],
        'Tab data',
        false,
        () => {},
        { customPrompt: { text: 'Always respond in JSON.', mode: 'suffix' } }
      );

      const prompt = capturedBody.messages[0].content;
      expect(prompt).toContain('Always respond in JSON.');
      expect(prompt).toContain('Omni-Context');
    });

    it('substitutes template variables in custom prompt', async () => {
      let capturedBody;
      globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse(200, 'data: [DONE]\n', true);
      });

      const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
      await provider.streamChat(
        [{ role: 'user', content: 'query text' }],
        'Context',
        false,
        () => {},
        { customPrompt: { text: 'Query: {QUERY}, Tabs: {TAB_COUNT}', mode: 'replace', query: 'my question', tabCount: 5, tabContent: 'stuff' } }
      );

      const prompt = capturedBody.messages[0].content;
      expect(prompt).toContain('Query: my question');
      expect(prompt).toContain('Tabs: 5');
    });

    it('shows no-context message when contextString is null', async () => {
      let capturedBody;
      globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse(200, 'data: [DONE]\n', true);
      });

      const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
      await provider.streamChat(
        [{ role: 'user', content: 'hi' }],
        null,
        false,
        () => {},
        {}
      );

      expect(capturedBody.messages[0].content).toContain('No tab content is currently indexed');
    });
  });

  describe('streamChat error handling', () => {
    it('throws on non-ok response with parsed error message', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse(500, JSON.stringify({ error: { message: 'Server overloaded' } }))
      );

      const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
      await expect(
        provider.streamChat([{ role: 'user', content: 'hi' }], 'ctx', false, () => {}, {})
      ).rejects.toThrow('Server overloaded');
    });
  });
});
