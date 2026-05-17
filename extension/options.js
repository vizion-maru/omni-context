/**
 * Omni-Context options page logic.
 * Reads/writes chrome.storage.local directly — no backend.
 */
(() => {
  'use strict';

  // ── Fallback models (used when live API fetch fails) ──────────────────────

  const FALLBACK_MODELS = {
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

  // Priority order for sorting: best/newest first per provider
  const MODEL_PRIORITY = {
    openai:     ['o4', 'o3', 'o1', 'gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5'],
    anthropic:  ['claude-opus-4', 'claude-sonnet-4', 'claude-opus-3', 'claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-haiku'],
    gemini:     ['gemini-2.0-flash', 'gemini-2', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0'],
    groq:       ['llama-3.3', 'llama-3.1-70b', 'llama-3.1-8b', 'llama-3', 'mixtral', 'gemma'],
    mistral:    ['mistral-large', 'mistral-medium', 'mistral-small', 'open-mistral'],
    deepseek:   ['deepseek-reasoner', 'deepseek-chat', 'deepseek-coder'],
    xai:        ['grok-3', 'grok-2', 'grok-1'],
    openrouter: ['gpt-4o', 'claude-3.5', 'gemini-pro', 'llama-3.3', 'llama-3.1'],
    perplexity: ['sonar-huge', 'sonar-large', 'sonar-small'],
    cohere:     ['command-r-plus', 'command-r', 'command-light']
  };

  const KEY_HINTS = {
    openai:     'Get your API key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>',
    anthropic:  'Get your API key at <a href="https://console.anthropic.com/" target="_blank">console.anthropic.com</a>',
    gemini:     'Get your API key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>',
    groq:       'Get your API key at <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a>',
    mistral:    'Get your API key at <a href="https://console.mistral.ai/api-keys/" target="_blank">console.mistral.ai</a>',
    deepseek:   'Get your API key at <a href="https://platform.deepseek.com/api_keys" target="_blank">platform.deepseek.com</a>',
    xai:        'Get your API key at <a href="https://console.x.ai/" target="_blank">console.x.ai</a>',
    openrouter: 'Get your API key at <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>',
    perplexity: 'Get your API key at <a href="https://www.perplexity.ai/settings/api" target="_blank">perplexity.ai/settings/api</a>',
    cohere:     'Get your API key at <a href="https://dashboard.cohere.com/api-keys" target="_blank">dashboard.cohere.com</a>'
  };

  const KEY_PLACEHOLDERS = {
    openai:     'sk-...',
    anthropic:  'sk-ant-...',
    gemini:     'AIza...',
    groq:       'gsk_...',
    mistral:    'your Mistral API key',
    deepseek:   'your DeepSeek API key',
    xai:        'xai-...',
    openrouter: 'sk-or-...',
    perplexity: 'pplx-...',
    cohere:     'your Cohere API key'
  };

  // ── DOM refs ─────────────────────────────────────────────────────────────────

  const providerBtns    = document.querySelectorAll('.provider-btn');
  const apiKeyInput     = document.getElementById('api-key');
  const modelSelect     = document.getElementById('model-select');
  const modelIndicator  = document.getElementById('model-indicator');
  const keyHint         = document.getElementById('key-hint');
  const saveBtn         = document.getElementById('save-btn');
  const testBtn         = document.getElementById('test-btn');
  const saveStatus      = document.getElementById('save-status');
  const testStatus      = document.getElementById('test-status');
  const reindexBtn      = document.getElementById('reindex-btn');
  const reindexStatus   = document.getElementById('reindex-status');
  const storageSizeText = document.getElementById('storage-size-text');
  const storageWarning  = document.getElementById('storage-warning');
  const historySizeBtn  = document.getElementById('history-size-btn');
  const historyClearBtn = document.getElementById('history-clear-btn');
  const historyStatus   = document.getElementById('history-status');
  const oauthCard       = document.getElementById('oauth-card');

  // ── State ─────────────────────────────────────────────────────────────────

  let selectedProvider = null;
  let debounceTimer    = null;

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    const stored = await chrome.storage.local.get([
      'provider', 'apiKey', 'model', 'chatgptOAuthEnabled'
    ]);

    // OAuth removed — BYOK only

    if (stored.provider) selectProvider(stored.provider, false);
    if (stored.apiKey)   apiKeyInput.value = stored.apiKey;

    if (stored.provider && stored.apiKey) {
      await loadModels(stored.provider, stored.apiKey);
      if (stored.model) modelSelect.value = stored.model;
    } else if (stored.provider && !stored.apiKey) {
      setModelState('empty');
    }

    providerBtns.forEach(btn => {
      btn.addEventListener('click', () => selectProvider(btn.dataset.provider, true));
    });

    apiKeyInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const key = apiKeyInput.value.trim();
      if (!selectedProvider || !key) {
        if (!key) setModelState('empty');
        return;
      }
      debounceTimer = setTimeout(() => loadModels(selectedProvider, key), 500);
    });

    saveBtn.addEventListener('click', saveSettings);
    testBtn.addEventListener('click', testConnection);
    reindexBtn.addEventListener('click', reindexTabs);
    historySizeBtn.addEventListener('click', refreshHistorySize);
    historyClearBtn.addEventListener('click', clearHistory);

    refreshHistorySize();
  }

  // ── Provider selection ────────────────────────────────────────────────────

  function selectProvider(provider, triggerFetch) {
    selectedProvider = provider;

    providerBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.provider === provider);
    });

    keyHint.innerHTML = KEY_HINTS[provider] || '';
    apiKeyInput.placeholder = KEY_PLACEHOLDERS[provider] || 'Paste your API key here...';

    const key = apiKeyInput.value.trim();
    if (triggerFetch && key) {
      loadModels(provider, key);
    } else if (!key) {
      setModelState('empty');
    }
  }

  // ── Dynamic model loading ─────────────────────────────────────────────────

  async function loadModels(provider, apiKey) {
    setModelState('loading');
    try {
      const models = await fetchModelsFromAPI(provider, apiKey);
      populateModelSelect(models, false);
    } catch (_err) {
      populateModelSelect(FALLBACK_MODELS[provider] || [], true);
    }
  }

  function setModelState(state) {
    modelSelect.innerHTML = '';
    modelSelect.classList.remove('loading');
    const opt = document.createElement('option');
    opt.value = '';
    if (state === 'empty') {
      opt.textContent = 'Erst API Key eingeben';
      setModelIndicator('', '');
    } else if (state === 'loading') {
      opt.textContent = 'Modelle werden geladen...';
      modelSelect.classList.add('loading');
      setModelIndicator('loading', 'Fetching models from API...');
    }
    modelSelect.appendChild(opt);
  }

  function populateModelSelect(models, isFallback) {
    const prev = modelSelect.value;
    modelSelect.classList.remove('loading');
    modelSelect.innerHTML = '';
    models.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      modelSelect.appendChild(opt);
    });
    if (prev && models.includes(prev)) modelSelect.value = prev;

    if (isFallback) {
      setModelIndicator('warn', '(Fallback \u2014 Key pr\u00fcfen)');
    } else {
      setModelIndicator('ok', `\u2713 ${models.length} model${models.length !== 1 ? 's' : ''} loaded`);
    }
  }

  function setModelIndicator(type, msg) {
    if (!modelIndicator) return;
    modelIndicator.textContent = msg;
    modelIndicator.className = 'model-indicator' + (msg ? ' visible ' + type : '');
  }

  // ── API fetch ─────────────────────────────────────────────────────────────

  async function fetchModelsFromAPI(provider, apiKey) {
    const EXCLUDE = ['embedding', 'embed', 'whisper', 'dall-e', 'tts', 'moderation', 'babbage', 'ada', 'curie'];
    const isExcluded = id => EXCLUDE.some(p => id.toLowerCase().includes(p));

    if (provider === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => {
          const name = (m.name || '').replace('models/', '');
          return (m.supportedGenerationMethods || []).includes('generateContent') && !isExcluded(name);
        })
        .map(m => m.name.replace('models/', ''));
      return sortModels(provider, models);
    }

    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.data || []).map(m => m.id).filter(id => !isExcluded(id));
      return sortModels(provider, models);
    }

    if (provider === 'cohere') {
      const res = await fetch('https://api.cohere.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => (m.endpoints || []).includes('chat'))
        .map(m => m.name);
      return sortModels(provider, models);
    }

    if (provider === 'perplexity') {
      // Perplexity does not expose a public /models endpoint; use fallback
      throw new Error('No public models endpoint');
    }

    // OpenAI-compatible providers
    const ENDPOINTS = {
      openai:     { url: 'https://api.openai.com/v1/models',              headers: { 'Authorization': `Bearer ${apiKey}` } },
      groq:       { url: 'https://api.groq.com/openai/v1/models',         headers: { 'Authorization': `Bearer ${apiKey}` } },
      mistral:    { url: 'https://api.mistral.ai/v1/models',              headers: { 'Authorization': `Bearer ${apiKey}` } },
      deepseek:   { url: 'https://api.deepseek.com/v1/models',            headers: { 'Authorization': `Bearer ${apiKey}` } },
      xai:        { url: 'https://api.x.ai/v1/models',                    headers: { 'Authorization': `Bearer ${apiKey}` } },
      openrouter: { url: 'https://openrouter.ai/api/v1/models',           headers: { 'Authorization': `Bearer ${apiKey}` } }
    };

    const config = ENDPOINTS[provider];
    if (!config) throw new Error(`Unknown provider: ${provider}`);

    const res = await fetch(config.url, { headers: config.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    let models = (data.data || []).map(m => m.id).filter(id => !isExcluded(id));

    if (provider === 'openai') {
      models = models.filter(id => {
        const lower = id.toLowerCase();
        return lower.startsWith('gpt-') || lower.startsWith('o1') ||
               lower.startsWith('o3') || lower.startsWith('o4') || lower.startsWith('chatgpt-');
      });
    }

    return sortModels(provider, models);
  }

  function sortModels(provider, models) {
    const prio = MODEL_PRIORITY[provider] || [];
    return [...models].sort((a, b) => {
      const al = a.toLowerCase(), bl = b.toLowerCase();
      const ai = prio.findIndex(p => al.includes(p));
      const bi = prio.findIndex(p => bl.includes(p));
      if (ai === -1 && bi === -1) return b.localeCompare(a);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      if (ai !== bi) return ai - bi;
      return b.localeCompare(a);
    });
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async function saveSettings() {
    const apiKey = apiKeyInput.value.trim();
    const model  = modelSelect.value;

    if (!selectedProvider) { showStatus(saveStatus, 'err', 'Please select a provider.'); return; }
    if (!apiKey)            { showStatus(saveStatus, 'err', 'Please enter your API key.'); return; }

    saveBtn.disabled = true;
    try {
      await chrome.storage.local.set({ provider: selectedProvider, apiKey, model });
      showStatus(saveStatus, 'ok', '&#10003; Settings saved.');
    } catch (err) {
      showStatus(saveStatus, 'err', 'Failed to save: ' + err.message);
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ── Test connection ───────────────────────────────────────────────────────

  async function testConnection() {
    const apiKey = apiKeyInput.value.trim();
    if (!selectedProvider || !apiKey) {
      showStatus(testStatus, 'err', 'Please select a provider and enter your API key first.');
      return;
    }

    testBtn.disabled = true;
    showStatus(testStatus, 'info', 'Testing connection...');

    try {
      const model = modelSelect.value || FALLBACK_MODELS[selectedProvider]?.[0];
      const result = await testViaBackground({ provider: selectedProvider, apiKey, model });
      if (result.ok) {
        showStatus(testStatus, 'ok', '&#10003; Connection successful! Your API key works.');
      } else {
        showStatus(testStatus, 'err', '&#10007; ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      showStatus(testStatus, 'err', 'Error: ' + err.message);
    } finally {
      testBtn.disabled = false;
    }
  }

  async function testViaBackground(settings) {
    await chrome.storage.local.set(settings);
    return new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: 'omni-chat' });
      port.onMessage.addListener((msg) => {
        if (msg.type === 'TEST_RESULT') { port.disconnect(); resolve(msg); }
      });
      port.postMessage({ type: 'TEST_CONNECTION' });
    });
  }

  // ── Re-index ──────────────────────────────────────────────────────────────

  async function reindexTabs() {
    reindexBtn.disabled = true;
    showStatus(reindexStatus, 'info', 'Re-indexing all open tabs...');
    try {
      await chrome.runtime.sendMessage({ type: 'REINDEX_ALL' });
      const { count } = await chrome.runtime.sendMessage({ type: 'GET_INDEX_SIZE' });
      showStatus(reindexStatus, 'ok', `&#10003; Done. ${count} tab${count !== 1 ? 's' : ''} indexed.`);
    } catch (err) {
      showStatus(reindexStatus, 'err', 'Error: ' + err.message);
    } finally {
      reindexBtn.disabled = false;
    }
  }

  // ── Chat History Storage Management ──────────────────────────────────────

  async function refreshHistorySize() {
    storageSizeText.textContent = 'Calculating...';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_HISTORY_SIZE' });
      const mb = (result.bytes / (1024 * 1024)).toFixed(2);
      const count = result.count || 0;
      storageSizeText.textContent = `${count} session${count !== 1 ? 's' : ''} · ${mb} MB`;

      const warnThreshold = 50 * 1024 * 1024; // 50 MB
      storageWarning.classList.toggle('hidden', result.bytes < warnThreshold);
    } catch (_) {
      storageSizeText.textContent = 'Could not retrieve size.';
    }
  }

  async function clearHistory() {
    if (!confirm('Delete ALL chat history? This cannot be undone.')) return;
    historyClearBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
      showStatus(historyStatus, 'ok', '&#10003; Chat history deleted.');
      await refreshHistorySize();
    } catch (err) {
      showStatus(historyStatus, 'err', 'Error: ' + err.message);
    } finally {
      historyClearBtn.disabled = false;
    }
  }

  // ── ChatGPT OAuth (PKCE, behind feature flag) ──────────────────────────────

  // Feature flag: chatgptOAuthEnabled must be true in storage to show this UI.
  // The actual ChatGPT OAuth endpoints are not yet public; this is a skeleton
  // implementation using PKCE that can be activated when endpoints become available.

  const OAUTH_CONFIG = {
    authUrl:     'https://auth.openai.com/authorize',
    tokenUrl:    'https://auth.openai.com/oauth/token',
    clientId:    'PLACEHOLDER_CLIENT_ID',
    scope:       'openid email profile',
    redirectUri: chrome.runtime.getURL('oauth-callback.html')
  };

  function initOAuth() {
    const oauthLoginBtn      = document.getElementById('oauth-login-btn');
    const oauthDisconnectBtn = document.getElementById('oauth-disconnect-btn');
    const oauthStatus        = document.getElementById('oauth-status');
    const oauthConnected     = document.getElementById('oauth-connected');
    const oauthDisconnected  = document.getElementById('oauth-disconnected');
    const oauthUsername      = document.getElementById('oauth-username');

    // Check if already connected
    chrome.storage.local.get(['oauthProvider', 'oauthAccessToken']).then(stored => {
      if (stored.oauthAccessToken) {
        oauthConnected.classList.remove('hidden');
        oauthDisconnected.classList.add('hidden');
        oauthUsername.textContent = 'ChatGPT User';
      }
    });

    if (oauthLoginBtn) {
      oauthLoginBtn.addEventListener('click', async () => {
        oauthLoginBtn.disabled = true;
        showStatus(oauthStatus, 'info', 'Opening login window...');
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'OAUTH_START', provider: 'openai' });
          if (resp?.ok) {
            oauthConnected.classList.remove('hidden');
            oauthDisconnected.classList.add('hidden');
            oauthUsername.textContent = 'ChatGPT User';
            showStatus(oauthStatus, 'ok', '&#10003; Connected!');
          } else {
            showStatus(oauthStatus, 'err', resp?.error || 'Login failed');
          }
        } catch (err) {
          showStatus(oauthStatus, 'err', 'Login failed: ' + err.message);
        } finally {
          oauthLoginBtn.disabled = false;
        }
      });
    }

    if (oauthDisconnectBtn) {
      oauthDisconnectBtn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'OAUTH_DISCONNECT' });
        oauthConnected.classList.add('hidden');
        oauthDisconnected.classList.remove('hidden');
      });
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showStatus(el, type, msg) {
    el.className = `status-msg visible ${type}`;
    el.innerHTML = msg;
    if (type === 'ok') {
      setTimeout(() => { el.className = 'status-msg'; }, 4000);
    }
  }

  init();
})();
