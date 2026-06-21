/**
 * AI provider implementations for Omni-Context BYOK extension.
 * All calls go directly from the service worker to the provider's API.
 * No backend, no proxying.
 */

import { errorLogger } from './error-logger.js';

/**
 * Factory: returns the appropriate provider instance based on settings.
 * Resolves OAuth-based authentication when no explicit provider is set.
 * @param {{provider?: string, apiKey?: string, model?: string, oauthAccessToken?: string, oauthProvider?: string}} settings
 *   Extension settings from chrome.storage.local.
 * @returns {{test: () => Promise<{ok: boolean, error?: string}>, streamChat: (messages: Array<{role: string, content: string}>, contextString: string|null, isResearch: boolean, onChunk: (text: string) => void) => Promise<void>}}
 *   Provider instance with test() and streamChat() methods.
 * @throws {Error} If provider identifier is unknown/unsupported.
 */
export function createProvider(settings) {
  // If OAuth is active for OpenAI but no explicit provider set, default to openai
  const provider = settings.provider || (settings.oauthProvider === 'openai' ? 'openai' : null);
  switch (provider) {
    case 'openai':      return new OpenAIProvider(settings);
    case 'anthropic':   return new AnthropicProvider(settings);
    case 'gemini':      return new GeminiProvider(settings);
    case 'groq':        return new GroqProvider(settings);
    case 'mistral':     return new MistralProvider(settings);
    case 'deepseek':    return new DeepSeekProvider(settings);
    case 'xai':         return new XAIProvider(settings);
    case 'openrouter':  return new OpenRouterProvider(settings);
    case 'perplexity':  return new PerplexityProvider(settings);
    case 'cohere':      return new CohereProvider(settings);
    default: throw new Error(`Unknown provider: ${settings.provider}`);
  }
}

/**
 * Validate that an API key works by making a cheap test request.
 * Creates a temporary provider instance and calls its test() method.
 * @param {{provider?: string, apiKey?: string, model?: string, oauthAccessToken?: string, oauthProvider?: string}} settings
 *   Extension settings containing at minimum provider and apiKey.
 * @returns {Promise<{ok: boolean, error?: string}>} Result object — ok:true on success,
 *   ok:false with a human-readable error string on failure.
 */
export async function testProvider(settings) {
  const provider = createProvider(settings);
  return provider.test();
}

// ── System prompts ────────────────────────────────────────────────────────────

/**
 * Build the default system prompt for tab-context-aware AI chat.
 * Includes rules for citation, language matching, and context boundaries.
 * @param {string|null} contextString  Concatenated tab content (null if no tabs indexed).
 * @returns {string} Full system prompt ready for the AI model.
 */
function buildSystemPrompt(contextString) {
  if (!contextString) {
    return `You are Omni-Context, a research assistant for the user's open browser tabs.
No tab content is currently indexed. Tell the user to browse some pages first so you can index them.`;
  }

  return `You are Omni-Context, a research assistant analyzing the user's open browser tabs.

Rules:
1. Answer ONLY from the provided tab content. If no tab answers the question, say: "I don't have an open tab that answers that." and suggest relevant search terms.
2. After EVERY factual claim, cite the source tab: [Tab: <exact tab title>]
3. NEVER invent or infer information not present in the tab content.
4. Respond in the same language as the user's question.
5. If tabs contain contradictory information, call it out explicitly and use a markdown comparison table.
6. When meaningful connections or relationships exist between topics across multiple tabs, include a mermaid mindmap to visualize them — use \`\`\`mermaid fenced blocks.
7. When directly comparing two or more sources, always use a markdown table.
8. After your answer, briefly suggest 1–2 follow-up angles or questions the user likely hasn't considered yet (prefix with "💡 **Worth exploring:**").

The following content has been extracted from the user's open browser tabs:

=== TAB CONTEXT ===
${contextString}
=== END CONTEXT ===

Use this context exclusively. Cite each tab as [Tab: <exact tab title>].`;
}

/**
 * Build the RESEARCH MODE system prompt for exhaustive multi-tab analysis.
 * Produces structured reports with per-tab analysis, synthesis, and gap detection.
 * @param {string|null} contextString  Concatenated tab content (null if no tabs indexed).
 * @returns {string} Full research-mode system prompt ready for the AI model.
 */
function buildResearchPrompt(contextString) {
  if (!contextString) {
    return `You are Omni-Context in RESEARCH MODE.
No tab content is currently indexed. Tell the user to browse some pages first.`;
  }

  return `You are Omni-Context in RESEARCH MODE. Analyze all tab content systematically and exhaustively.

Rules:
1. Cite every source as [Tab: <exact tab title>]
2. Be thorough — examine every relevant tab individually
3. Respond in the same language as the user's question
4. Use mermaid mindmap diagrams (in \`\`\`mermaid fenced blocks) to show topic relationships
5. Use markdown tables when comparing data across tabs

The following content has been extracted from the user's open browser tabs:

=== TAB CONTEXT ===
${contextString}
=== END CONTEXT ===

For the user's question, provide a structured research report:

## Per-Tab Analysis
Summarize what each relevant tab says about the question (one section per tab, cite with [Tab: title]).

## Synthesis
What is the overall picture? Include a mermaid mindmap if the topics are interconnected.

## Contradictions
Identify any contradictions or conflicts between tabs. Use a comparison table if applicable.

## Information Gaps
What relevant information is missing across all tabs?

## 💡 Worth Exploring
2–3 follow-up angles the user likely hasn't considered.`;
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

class OpenAIProvider {
  constructor({ apiKey, model = 'gpt-4o-mini', oauthAccessToken, oauthProvider }) {
    // Prefer OAuth token for OpenAI if available
    this.apiKey = (oauthProvider === 'openai' && oauthAccessToken) ? oauthAccessToken : apiKey;
    this.model = model;
    this.baseUrl = 'https://api.openai.com/v1';
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (res.status === 401) return { ok: false, error: 'Invalid API key.' };
      if (res.status === 429) return { ok: false, error: 'Rate limit or quota exceeded.' };
      if (!res.ok) return { ok: false, error: `API error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: 4096
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `OpenAI API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
        if (chunk) onChunk(chunk);
      } catch (err) { errorLogger.log('providers:OpenAI:streamChunk', err); }
    });
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

class AnthropicProvider {
  constructor({ apiKey, model = 'claude-3-5-haiku-20241022' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://api.anthropic.com/v1';
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      if (res.status === 401) return { ok: false, error: 'Invalid API key.' };
      if (res.status === 403) return { ok: false, error: 'API key does not have permission.' };
      if (res.status === 429) return { ok: false, error: 'Rate limit or quota exceeded.' };
      if (!res.ok) {
        const body = await res.text();
        let msg = `API error: HTTP ${res.status}`;
        try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
        return { ok: false, error: msg };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        stream: true
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `Anthropic API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      try {
        const json = JSON.parse(data);
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
          onChunk(json.delta.text);
        }
      } catch (err) { errorLogger.log('providers:Anthropic:streamChunk', err); }
    });
  }
}

// ── Google Gemini ──────────────────────────────────────────────────────────────

class GeminiProvider {
  constructor({ apiKey, model = 'gemini-2.0-flash' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  }

  async test() {
    try {
      const res = await fetch(
        `${this.baseUrl}/models?key=${encodeURIComponent(this.apiKey)}`
      );
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return { ok: false, error: 'Invalid API key or insufficient permissions.' };
      }
      if (res.status === 429) return { ok: false, error: 'Rate limit exceeded.' };
      if (!res.ok) return { ok: false, error: `API error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?key=${encodeURIComponent(this.apiKey)}&alt=sse`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 4096 }
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `Gemini API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      try {
        const text = JSON.parse(data).candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) onChunk(text);
      } catch (err) { errorLogger.log('providers:Gemini:streamChunk', err); }
    });
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────────

class GroqProvider {
  constructor({ apiKey, model = 'llama-3.3-70b-versatile' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://api.groq.com/openai/v1';
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (res.status === 401) return { ok: false, error: 'Invalid API key.' };
      if (res.status === 429) return { ok: false, error: 'Rate limit exceeded.' };
      if (!res.ok) return { ok: false, error: `API error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: 4096
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `Groq API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
        if (chunk) onChunk(chunk);
      } catch (err) { errorLogger.log('providers:Groq:streamChunk', err); }
    });
  }
}

// ── Mistral ───────────────────────────────────────────────────────────────────

class MistralProvider {
  constructor({ apiKey, model = 'mistral-large-latest' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://api.mistral.ai/v1';
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (res.status === 401) return { ok: false, error: 'Invalid API key.' };
      if (res.status === 429) return { ok: false, error: 'Rate limit exceeded.' };
      if (!res.ok) return { ok: false, error: `API error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: 4096
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `Mistral API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
        if (chunk) onChunk(chunk);
      } catch (err) { errorLogger.log('providers:Mistral:streamChunk', err); }
    });
  }
}

// ── DeepSeek ──────────────────────────────────────────────────────────────────

class DeepSeekProvider {
  constructor({ apiKey, model = 'deepseek-chat' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://api.deepseek.com/v1';
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (res.status === 401) return { ok: false, error: 'Invalid API key.' };
      if (res.status === 429) return { ok: false, error: 'Rate limit exceeded.' };
      if (!res.ok) return { ok: false, error: `API error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: 4096
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `DeepSeek API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
        if (chunk) onChunk(chunk);
      } catch (err) { errorLogger.log('providers:DeepSeek:streamChunk', err); }
    });
  }
}

// ── xAI ───────────────────────────────────────────────────────────────────────

class XAIProvider {
  constructor({ apiKey, model = 'grok-2' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://api.x.ai/v1';
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (res.status === 401) return { ok: false, error: 'Invalid API key.' };
      if (res.status === 429) return { ok: false, error: 'Rate limit exceeded.' };
      if (!res.ok) return { ok: false, error: `API error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: 4096
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `xAI API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
        if (chunk) onChunk(chunk);
      } catch (err) { errorLogger.log('providers:xAI:streamChunk', err); }
    });
  }
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

class OpenRouterProvider {
  constructor({ apiKey, model = 'openai/gpt-4o-mini' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://openrouter.ai/api/v1';
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (res.status === 401) return { ok: false, error: 'Invalid API key.' };
      if (res.status === 429) return { ok: false, error: 'Rate limit exceeded.' };
      if (!res.ok) return { ok: false, error: `API error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'chrome-extension://omni-context',
        'X-Title': 'Omni-Context'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: 4096
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `OpenRouter API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
        if (chunk) onChunk(chunk);
      } catch (err) { errorLogger.log('providers:OpenRouter:streamChunk', err); }
    });
  }
}

// ── Perplexity ────────────────────────────────────────────────────────────────

class PerplexityProvider {
  constructor({ apiKey, model = 'llama-3.1-sonar-large-128k-online' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://api.perplexity.ai';
  }

  async test() {
    try {
      // Perplexity doesn't have a simple models ping — do a minimal chat call
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1
        })
      });
      if (res.status === 401) return { ok: false, error: 'Invalid API key.' };
      if (res.status === 429) return { ok: false, error: 'Rate limit exceeded.' };
      if (!res.ok) return { ok: false, error: `API error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: 4096
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `Perplexity API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
        if (chunk) onChunk(chunk);
      } catch (err) { errorLogger.log('providers:Perplexity:streamChunk', err); }
    });
  }
}

// ── Cohere ────────────────────────────────────────────────────────────────────

class CohereProvider {
  constructor({ apiKey, model = 'command-r-plus' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://api.cohere.com/v2';
  }

  async test() {
    try {
      const res = await fetch('https://api.cohere.com/v1/models', {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });
      if (res.status === 401) return { ok: false, error: 'Invalid API key.' };
      if (res.status === 429) return { ok: false, error: 'Rate limit exceeded.' };
      if (!res.ok) return { ok: false, error: `API error: HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }

  async streamChat(messages, contextString, isResearch, onChunk, { signal } = {}) {
    const systemPrompt = isResearch
      ? buildResearchPrompt(contextString)
      : buildSystemPrompt(contextString);

    const cohereMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const response = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: cohereMessages,
        stream: true
      }),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      let msg = `Cohere API error (HTTP ${response.status})`;
      try { msg = JSON.parse(body).message || msg; } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response.body, (data) => {
      try {
        const json = JSON.parse(data);
        if (json.type === 'content-delta' && json.delta?.type === 'text_delta') {
          onChunk(json.delta.text);
        }
      } catch (err) { errorLogger.log('providers:Cohere:streamChunk', err); }
    });
  }
}

// ── SSE stream reader ──────────────────────────────────────────────────────────

/**
 * Read a Server-Sent Events (SSE) stream and invoke a callback for each data payload.
 * Handles chunked transfer encoding, buffering incomplete lines across reads.
 * @param {ReadableStream} body  The response body stream from a fetch() call.
 * @param {function(string): void} onData  Callback invoked with the raw data string
 *   (after stripping the "data: " prefix) for each SSE event line.
 * @returns {Promise<void>} Resolves when the stream is fully consumed.
 */
async function readSSEStream(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        onData(trimmed.slice(6));
      }
    }
  }

  // Flush remaining
  if (buffer.startsWith('data: ')) {
    onData(buffer.slice(6));
  }
}
