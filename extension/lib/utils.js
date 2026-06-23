/**
 * Shared utility functions for Omni-Context extension.
 */

/**
 * Estimate token count (rough: ~4 chars per token).
 * @param {string} text  Input text to estimate tokens for.
 * @returns {number} Approximate token count (always ≥ 0).
 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Truncate text to approximately maxTokens tokens.
 * Uses the 4-chars-per-token heuristic. Appends '...' if truncated.
 * @param {string} text  Input text to truncate.
 * @param {number} maxTokens  Maximum number of tokens to allow.
 * @returns {string} Original text if within limit, or truncated text with '...' suffix.
 */
export function truncateToTokens(text, maxTokens) {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

/**
 * Sanitize text for safe inclusion in prompts — strips control chars,
 * normalizes whitespace, removes any HTML tags that slipped through.
 * @param {string} text  Raw text that may contain HTML or control characters.
 * @returns {string} Cleaned text safe for prompt injection. Returns '' for falsy input.
 */
export function sanitizeText(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escape HTML for safe DOM insertion.
 * Converts &, <, >, ", and ' to their HTML entity equivalents.
 * Escaping all five OWASP-recommended characters prevents XSS in both
 * double-quoted and single-quoted attribute contexts.
 * @param {string} str  Untrusted string to escape.
 * @returns {string} HTML-safe string with entities escaped.
 */
export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Default model per provider.
 * @type {Record<string, string>}
 */
export const DEFAULT_MODELS = {
  openai:      'gpt-4o-mini',
  anthropic:   'claude-3-5-haiku-20241022',
  gemini:      'gemini-2.0-flash',
  groq:        'llama-3.3-70b-versatile',
  mistral:     'mistral-large-latest',
  deepseek:    'deepseek-chat',
  xai:         'grok-2',
  openrouter:  'openai/gpt-4o-mini',
  perplexity:  'llama-3.1-sonar-large-128k-online',
  cohere:      'command-r-plus'
};

/**
 * Fallback model lists per provider (used when live API fetch fails).
 * Values are plain model IDs, best/newest first.
 * @type {Record<string, string[]>}
 */
export const PROVIDER_MODELS = {
  openai:     ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  anthropic:  ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  gemini:     ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  groq:       ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  mistral:    ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
  deepseek:   ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
  xai:        ['grok-2', 'grok-2-mini'],
  openrouter: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-pro-1.5', 'meta-llama/llama-3.3-70b-instruct'],
  perplexity: ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online', 'llama-3.1-sonar-huge-128k-online'],
  cohere:     ['command-r-plus', 'command-r', 'command-light']
};
