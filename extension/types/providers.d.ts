// ── Provider configuration ────────────────────────────────────────────────────

export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'openrouter'
  | 'perplexity'
  | 'cohere';

export interface ProviderSettings {
  provider: ProviderName | string | null;
  apiKey: string | null;
  model: string | null;
  oauthProvider?: string | null;
  oauthAccessToken?: string | null;
  oauthRefreshToken?: string | null;
  oauthTokenExpiry?: number | null;
}

export interface CustomPrompt {
  text: string;
  mode: 'prefix' | 'suffix' | 'replace';
  query?: string;
  tabCount?: number;
  tabContent?: string;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface StreamChatOptions {
  signal?: AbortSignal;
  customPrompt?: CustomPrompt | null;
}

export type OnChunkCallback = (text: string) => void;

export interface ProviderTestResult {
  ok: boolean;
  error?: string;
}

export interface AIProvider {
  test(): Promise<ProviderTestResult>;
  streamChat(
    messages: Array<{ role: string; content: string }>,
    contextString: string | null,
    isResearch: boolean,
    onChunk: OnChunkCallback,
    options?: StreamChatOptions
  ): Promise<void>;
}

// ── SSE streaming types ───────────────────────────────────────────────────────

export interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

export interface AnthropicStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  message?: { id: string; model: string; usage: { input_tokens: number; output_tokens: number } };
  delta?: { type: string; text?: string };
  index?: number;
}

export interface GeminiStreamChunk {
  candidates: Array<{
    content: { parts: Array<{ text: string }>; role: string };
    finishReason?: string;
  }>;
}
