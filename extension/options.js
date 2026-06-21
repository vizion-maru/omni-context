/**
 * Omni-Context options page logic.
 * Reads/writes chrome.storage.local directly — no backend.
 */
import { PROVIDER_MODELS } from './lib/utils.js';
import { FREE_PROVIDERS } from './lib/feature-gates.js';
import { errorLogger } from './lib/error-logger.js';

(() => {
  'use strict';

  const msg = chrome.i18n.getMessage;

  function localizeHtml() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const translated = msg(el.dataset.i18n);
      if (translated) el.textContent = translated;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const translated = msg(el.dataset.i18nPlaceholder);
      if (translated) el.placeholder = translated;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const translated = msg(el.dataset.i18nTitle);
      if (translated) el.title = translated;
    });
  }

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
  const upgradeBtn      = document.getElementById('upgrade-btn');
  const proStatusFree   = document.getElementById('pro-status-free');
  const proStatusActive = document.getElementById('pro-status-active');
  const debugLogPre     = document.getElementById('debug-log-pre');
  const debugLogRefresh = document.getElementById('debug-log-refresh-btn');
  const debugLogClear   = document.getElementById('debug-log-clear-btn');
  const debugLogStatus  = document.getElementById('debug-log-status');

  // ── State ─────────────────────────────────────────────────────────────────

  let selectedProvider = null;
  let debounceTimer    = null;
  let isProUser        = false;

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    localizeHtml();
    document.title = msg('OPTIONS_PAGE_TITLE');
    const stored = await chrome.storage.local.get([
      'provider', 'apiKey', 'model', 'chatgptOAuthEnabled'
    ]);

    await loadProStatus();

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
    if (debugLogRefresh) debugLogRefresh.addEventListener('click', refreshDebugLog);
    if (debugLogClear) debugLogClear.addEventListener('click', clearDebugLog);

    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_PAYMENT_PAGE' });
      });
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.omni_pro_status) {
        isProUser = changes.omni_pro_status.newValue === true;
        updateProUI();
      }
    });

    refreshHistorySize();
    refreshDebugLog();
  }

  // ── Provider selection ────────────────────────────────────────────────────

  function selectProvider(provider, triggerFetch) {
    if (!isProUser && !FREE_PROVIDERS.has(provider)) {
      showStatus(saveStatus, 'err', '\uD83D\uDD12 ' + msg('OPT_PROVIDER_REQUIRES_PRO', [provider]));
      return;
    }

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
    } catch (err) {
      console.warn('[OC options:loadModels]', err);
      populateModelSelect(PROVIDER_MODELS[provider] || [], true);
    }
  }

  function setModelState(state) {
    modelSelect.innerHTML = '';
    modelSelect.classList.remove('loading');
    const opt = document.createElement('option');
    opt.value = '';
    if (state === 'empty') {
      opt.textContent = msg('OPT_ENTER_KEY_FIRST');
      setModelIndicator('', '');
    } else if (state === 'loading') {
      opt.textContent = msg('OPT_MODELS_LOADING');
      modelSelect.classList.add('loading');
      setModelIndicator('loading', msg('OPT_FETCHING_MODELS'));
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
      setModelIndicator('warn', msg('OPT_FALLBACK_CHECK_KEY'));
    } else {
      setModelIndicator('ok', '\u2713 ' + msg('OPT_MODELS_LOADED', [String(models.length), models.length !== 1 ? 's' : '']));
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

    if (!selectedProvider) { showStatus(saveStatus, 'err', msg('OPT_SELECT_PROVIDER')); return; }
    if (!apiKey)            { showStatus(saveStatus, 'err', msg('OPT_ENTER_API_KEY')); return; }

    saveBtn.disabled = true;
    try {
      await chrome.storage.local.set({ provider: selectedProvider, apiKey, model });
      showStatus(saveStatus, 'ok', '✓ ' + msg('OPT_SETTINGS_SAVED'));
    } catch (err) {
      showStatus(saveStatus, 'err', msg('OPT_SAVE_FAILED', [err.message]));
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ── Test connection ───────────────────────────────────────────────────────

  async function testConnection() {
    const apiKey = apiKeyInput.value.trim();
    if (!selectedProvider || !apiKey) {
      showStatus(testStatus, 'err', msg('OPT_SELECT_PROVIDER_AND_KEY'));
      return;
    }

    testBtn.disabled = true;
    showStatus(testStatus, 'info', msg('OPT_TESTING'));

    try {
      const model = modelSelect.value || PROVIDER_MODELS[selectedProvider]?.[0];
      const result = await testViaBackground({ provider: selectedProvider, apiKey, model });
      if (result.ok) {
        showStatus(testStatus, 'ok', '✓ ' + msg('OPT_TEST_SUCCESS'));
      } else {
        showStatus(testStatus, 'err', '✗ ' + (result.error || 'Unknown error'));
      }
    } catch (err) {
      showStatus(testStatus, 'err', msg('ERROR_PREFIX') + err.message);
    } finally {
      testBtn.disabled = false;
    }
  }

  async function testViaBackground(settings) {
    await chrome.storage.local.set(settings);
    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 15000;
      const port = chrome.runtime.connect({ name: 'omni-chat' });
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        port.disconnect();
        reject(new Error('Connection test timed out after 15s — is the service worker active?'));
      }, TIMEOUT_MS);

      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError?.message || 'Port disconnected unexpectedly';
        reject(new Error(err));
      });

      port.onMessage.addListener((msg) => {
        if (msg.type === 'TEST_RESULT') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          port.disconnect();
          resolve(msg);
        }
      });

      port.postMessage({ type: 'TEST_CONNECTION' });
    });
  }

  // ── Re-index ──────────────────────────────────────────────────────────────

  async function reindexTabs() {
    reindexBtn.disabled = true;
    showStatus(reindexStatus, 'info', msg('OPT_REINDEXING'));
    try {
      await chrome.runtime.sendMessage({ type: 'REINDEX_ALL' });
      const { count } = await chrome.runtime.sendMessage({ type: 'GET_INDEX_SIZE' });
      showStatus(reindexStatus, 'ok', '✓ ' + msg('OPT_REINDEX_DONE', [String(count), count !== 1 ? 's' : '']));
    } catch (err) {
      showStatus(reindexStatus, 'err', msg('ERROR_PREFIX') + err.message);
    } finally {
      reindexBtn.disabled = false;
    }
  }

  // ── Chat History Storage Management ──────────────────────────────────────

  async function refreshHistorySize() {
    storageSizeText.textContent = msg('CALCULATING');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_HISTORY_SIZE' });
      const mb = (result.bytes / (1024 * 1024)).toFixed(2);
      const count = result.count || 0;
      storageSizeText.textContent = msg('OPT_SESSION_COUNT', [String(count), count !== 1 ? 's' : '', mb]);

      const warnThreshold = 50 * 1024 * 1024; // 50 MB
      storageWarning.classList.toggle('hidden', result.bytes < warnThreshold);
    } catch (err) {
      console.warn('[OC options:refreshHistorySize]', err);
      storageSizeText.textContent = msg('OPT_SIZE_ERROR');
    }
  }

  async function clearHistory() {
    if (!confirm(msg('OPT_CONFIRM_DELETE_HISTORY'))) return;
    historyClearBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
      showStatus(historyStatus, 'ok', '✓ ' + msg('OPT_HISTORY_DELETED'));
    } catch (err) {
      showStatus(historyStatus, 'err', msg('ERROR_PREFIX') + err.message);
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
        showStatus(oauthStatus, 'info', msg('OPT_OPENING_LOGIN'));
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'OAUTH_START', provider: 'openai' });
          if (resp?.ok) {
            oauthConnected.classList.remove('hidden');
            oauthDisconnected.classList.add('hidden');
            oauthUsername.textContent = 'ChatGPT User';
            showStatus(oauthStatus, 'ok', '✓ ' + msg('OPT_CONNECTED'));
          } else {
            showStatus(oauthStatus, 'err', resp?.error || 'Login failed');
          }
        } catch (err) {
          showStatus(oauthStatus, 'err', msg('OPT_LOGIN_FAILED', [err.message]));
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

  function showStatus(el, type, text) {
    el.className = `status-msg visible ${type}`;
    el.textContent = text;
    if (type === 'ok') {
      setTimeout(() => { el.className = 'status-msg'; }, 4000);
    }
  }

  // ── Pro status ───────────────────────────────────────────────────────────

  async function loadProStatus() {
    try {
      const result = await chrome.storage.sync.get('omni_pro_status');
      isProUser = result.omni_pro_status === true;
    } catch (err) {
      console.warn('[OC options:loadProStatus]', err);
      isProUser = false;
    }
    updateProUI();
  }

  function updateProUI() {
    if (proStatusFree) proStatusFree.classList.toggle('hidden', isProUser);
    if (proStatusActive) proStatusActive.classList.toggle('hidden', !isProUser);

    providerBtns.forEach(btn => {
      const provider = btn.dataset.provider;
      const lock = btn.querySelector('[data-lock]');
      const isLocked = !isProUser && !FREE_PROVIDERS.has(provider);
      btn.classList.toggle('provider-locked', isLocked);
      if (lock) lock.classList.toggle('hidden', !isLocked);
    });
  }

  // ── Debug log ──────────────────────────────────────────────────────────────

  async function refreshDebugLog() {
    if (!debugLogPre) return;
    await errorLogger.load();
    const entries = errorLogger.getAll();
    if (entries.length === 0) {
      debugLogPre.textContent = msg('DEBUG_LOG_EMPTY');
      return;
    }
    debugLogPre.textContent = entries.map(e => {
      const ts = new Date(e.timestamp).toLocaleString();
      return `[${ts}] ${e.source}: ${e.message}${e.stack ? '\n  ' + e.stack.split('\n')[1]?.trim() : ''}`;
    }).join('\n');
    debugLogPre.scrollTop = debugLogPre.scrollHeight;
  }

  async function clearDebugLog() {
    await errorLogger.clear();
    if (debugLogPre) debugLogPre.textContent = msg('DEBUG_LOG_EMPTY');
    if (debugLogStatus) showStatus(debugLogStatus, 'ok', '✓ ' + msg('OPT_LOG_CLEARED'));
  }

  init();
})();
