import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateEmbedding, cosineSimilarity, supportsEmbeddings, getEmbeddingConfig } from '../extension/lib/embeddings.js';

describe('embeddings', () => {
  describe('cosineSimilarity', () => {
    it('returns 1 for identical normalized vectors', () => {
      const v = new Float32Array([0.6, 0.8]);
      expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('returns -1 for opposite vectors', () => {
      const a = new Float32Array([1, 0]);
      const b = new Float32Array([-1, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
    });

    it('returns 0 when first vector is null', () => {
      expect(cosineSimilarity(null, new Float32Array([1, 2]))).toBe(0);
    });

    it('returns 0 when second vector is null', () => {
      expect(cosineSimilarity(new Float32Array([1, 2]), null)).toBe(0);
    });

    it('returns 0 for empty vectors', () => {
      expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(0);
    });

    it('returns 0 for mismatched lengths', () => {
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([1, 2]);
      expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('handles non-normalized vectors correctly', () => {
      const a = new Float32Array([3, 4]);
      const b = new Float32Array([6, 8]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    });
  });

  describe('supportsEmbeddings', () => {
    it('returns true for openai', () => {
      expect(supportsEmbeddings('openai')).toBe(true);
    });

    it('returns true for generic-embedding', () => {
      expect(supportsEmbeddings('generic-embedding')).toBe(true);
    });

    it('returns false for groq', () => {
      expect(supportsEmbeddings('groq')).toBe(false);
    });

    it('returns false for anthropic', () => {
      expect(supportsEmbeddings('anthropic')).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(supportsEmbeddings(undefined)).toBe(false);
    });
  });

  describe('getEmbeddingConfig', () => {
    it('returns config for supported provider with API key', () => {
      const cfg = getEmbeddingConfig({ provider: 'openai', apiKey: 'sk-test' });
      expect(cfg).toEqual({
        provider: 'openai',
        apiKey: 'sk-test',
        embeddingEndpoint: null,
        embeddingModel: 'text-embedding-3-small',
      });
    });

    it('uses custom endpoint and model when provided', () => {
      const cfg = getEmbeddingConfig({
        provider: 'openai',
        apiKey: 'sk-test',
        embeddingEndpoint: 'https://custom.api/embed',
        embeddingModel: 'custom-model',
      });
      expect(cfg.embeddingEndpoint).toBe('https://custom.api/embed');
      expect(cfg.embeddingModel).toBe('custom-model');
    });

    it('returns null for unsupported provider', () => {
      expect(getEmbeddingConfig({ provider: 'anthropic', apiKey: 'key' })).toBeNull();
    });

    it('returns null when apiKey is missing', () => {
      expect(getEmbeddingConfig({ provider: 'openai' })).toBeNull();
    });

    it('returns null for null settings', () => {
      expect(getEmbeddingConfig(null)).toBeNull();
    });
  });

  describe('generateEmbedding', () => {
    let fetchMock;

    beforeEach(() => {
      fetchMock = vi.fn();
      globalThis.fetch = fetchMock;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete globalThis.fetch;
    });

    const config = { provider: 'openai', apiKey: 'sk-test' };

    it('returns Float32Array on successful response', async () => {
      const vector = [1, 2, 3];
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: vector }] }),
      });

      const result = await generateEmbedding('hello world', config);
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(3);
      expect(result[0]).toBeCloseTo(1);
      expect(result[1]).toBeCloseTo(2);
      expect(result[2]).toBeCloseTo(3);
    });

    it('sends correct request to OpenAI endpoint', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      });

      await generateEmbedding('test text', config);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer sk-test',
          },
        })
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.input).toBe('test text');
      expect(body.model).toBe('text-embedding-3-small');
    });

    it('returns null on HTTP error', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      });

      const result = await generateEmbedding('test', config);
      expect(result).toBeNull();
    });

    it('returns null when response has no embedding vector', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      const result = await generateEmbedding('test', config);
      expect(result).toBeNull();
    });

    it('returns null when response embedding is empty array', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [] }] }),
      });

      const result = await generateEmbedding('test', config);
      expect(result).toBeNull();
    });

    it('returns null for empty text', async () => {
      const result = await generateEmbedding('', config);
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null for missing apiKey', async () => {
      const result = await generateEmbedding('hello', { provider: 'openai' });
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null on network error', async () => {
      fetchMock.mockRejectedValue(new Error('network failure'));

      const result = await generateEmbedding('test', config);
      expect(result).toBeNull();
    });

    it('truncates input text to 32000 chars', async () => {
      const longText = 'x'.repeat(50000);
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.5] }] }),
      });

      await generateEmbedding(longText, config);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.input.length).toBe(32000);
    });

    it('uses custom endpoint when configured', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      });

      await generateEmbedding('test', {
        ...config,
        embeddingEndpoint: 'https://my-server.com/embed',
      });

      expect(fetchMock.mock.calls[0][0]).toBe('https://my-server.com/embed');
    });
  });
});
