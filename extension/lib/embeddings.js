import { errorLogger } from './error-logger.js';

const OPENAI_EMBEDDING_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_MODEL = 'text-embedding-3-small';

/**
 * Generate an embedding vector for the given text.
 * Uses the user's configured provider — OpenAI or a generic endpoint.
 *
 * @param {string} text  Text to embed (will be truncated to ~8000 tokens).
 * @param {{provider: string, apiKey: string, embeddingEndpoint?: string, embeddingModel?: string}} config
 *   Embedding configuration from user settings.
 * @returns {Promise<Float32Array|null>} Embedding vector, or null on failure.
 */
export async function generateEmbedding(text, config) {
  if (!text || !config?.apiKey) return null;

  const input = text.slice(0, 32000);

  if (config.provider === 'gemini') {
    return _generateGeminiEmbedding(input, config);
  }

  const endpoint = resolveEndpoint(config);
  const model = config.embeddingModel || DEFAULT_MODEL;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({ input, model })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      errorLogger.log('embeddings:generate', `HTTP ${response.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const vector = data?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      errorLogger.log('embeddings:generate', 'No embedding vector in response');
      return null;
    }

    return new Float32Array(vector);
  } catch (err) {
    errorLogger.log('embeddings:generate', err);
    return null;
  }
}

/**
 * Generate an embedding vector using Google's Gemini embedding API.
 * Uses the `embedContent` endpoint with the configured model (defaults to text-embedding-004).
 * Called internally by generateEmbedding() when the provider is 'gemini'.
 * @param {string} input  Pre-truncated text to embed (max ~32000 chars).
 * @param {{provider: string, apiKey: string, embeddingModel?: string}} config
 *   Embedding configuration; apiKey must be a valid Gemini API key.
 * @returns {Promise<Float32Array|null>} Embedding vector, or null on HTTP/parse failure.
 * @private
 */
async function _generateGeminiEmbedding(input, config) {
  const model = config.embeddingModel || 'text-embedding-004';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(config.apiKey)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text: input }] }
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      errorLogger.log('embeddings:gemini', `HTTP ${response.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const vector = data?.embedding?.values;
    if (!Array.isArray(vector) || vector.length === 0) {
      errorLogger.log('embeddings:gemini', 'No embedding vector in response');
      return null;
    }

    return new Float32Array(vector);
  } catch (err) {
    errorLogger.log('embeddings:gemini', err);
    return null;
  }
}

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if either vector is null/empty or they differ in length.
 *
 * @param {Float32Array|number[]|null} a  First vector.
 * @param {Float32Array|number[]|null} b  Second vector.
 * @returns {number} Similarity score between -1 and 1 (typically 0–1 for normalized embeddings).
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Check if the given provider supports embedding generation.
 * @param {string} provider  Provider ID (e.g. 'openai', 'groq').
 * @returns {boolean}
 */
export function supportsEmbeddings(provider) {
  return provider === 'openai' || provider === 'gemini' || provider === 'mistral' || provider === 'generic-embedding';
}

/**
 * Build embedding config from extension settings.
 * Returns null if the provider doesn't support embeddings.
 *
 * @param {{provider: string, apiKey: string, embeddingEndpoint?: string, embeddingModel?: string}} settings
 * @returns {{provider: string, apiKey: string, embeddingEndpoint?: string, embeddingModel?: string}|null}
 */
export function getEmbeddingConfig(settings) {
  if (!settings?.apiKey) return null;
  if (!supportsEmbeddings(settings.provider)) return null;

  const defaults = {
    openai: 'text-embedding-3-small',
    gemini: 'text-embedding-004',
    mistral: 'mistral-embed',
    'generic-embedding': DEFAULT_MODEL
  };

  return {
    provider: settings.provider,
    apiKey: settings.apiKey,
    embeddingEndpoint: settings.embeddingEndpoint || null,
    embeddingModel: settings.embeddingModel || defaults[settings.provider] || DEFAULT_MODEL
  };
}

/**
 * Resolve the embedding API endpoint URL based on config.
 * @param {{provider: string, embeddingEndpoint?: string}} config
 * @returns {string}
 */
function resolveEndpoint(config) {
  if (config.embeddingEndpoint) return config.embeddingEndpoint;
  if (config.provider === 'mistral') return 'https://api.mistral.ai/v1/embeddings';
  return OPENAI_EMBEDDING_URL;
}
