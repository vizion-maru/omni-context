/**
 * Omni-Context options page logic.
 * Reads/writes chrome.storage.local directly — no backend.
 */
import { PROVIDER_MODELS, escHtml } from './lib/utils.js';
import { FREE_PROVIDERS } from './lib/feature-gates.js';
import { errorLogger } from './lib/error-logger.js';
import { resetOnboarding } from './onboarding.js';
import { SyncManager } from './lib/sync.js';
import { exportToGDrive, importFromGDrive, listBackups, deleteBackup, disconnectGDrive } from './lib/gdrive-backup.js';

(() => {
  'use strict';

  const msg = chrome.i18n.getMessage;

  /**
   * Apply i18n translations to all DOM elements with data-i18n attributes.
   * Scans for three attribute types:
   *  - `data-i18n` → sets element's textContent
   *  - `data-i18n-placeholder` → sets input placeholder attribute
   *  - `data-i18n-title` → sets element's title (tooltip) attribute
   * Uses chrome.i18n.getMessage for translation lookup; skips elements
   * where the message key returns empty (missing translation).
   */
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

  const upgradeBtn      = document.getElementById('upgrade-btn');
  const proStatusFree   = document.getElementById('pro-status-free');
  const proStatusActive = document.getElementById('pro-status-active');
  const debugLogPre     = document.getElementById('debug-log-pre');
  const debugLogRefresh = document.getElementById('debug-log-refresh-btn');
  const debugLogClear   = document.getElementById('debug-log-clear-btn');
  const debugLogStatus  = document.getElementById('debug-log-status');
  const themeOptions    = document.getElementById('theme-options');
  const usageRefreshBtn = document.getElementById('usage-refresh-btn');
  const usageResetBtn   = document.getElementById('usage-reset-btn');
  const usageStatus     = document.getElementById('usage-status');
  const usageToday      = document.getElementById('usage-today');
  const usageWeekly     = document.getElementById('usage-weekly');
  const usageCost       = document.getElementById('usage-cost');
  const usageBreakdown  = document.getElementById('usage-breakdown-content');
  const excludedListEl  = document.getElementById('excluded-domain-list');
  const excludedInput   = document.getElementById('excluded-domain-input');
  const addExcludedBtn  = document.getElementById('add-excluded-btn');
  const pinnedListEl    = document.getElementById('pinned-domain-list');
  const pinnedInput     = document.getElementById('pinned-domain-input');
  const addPinnedBtn    = document.getElementById('add-pinned-btn');
  const customPromptCard   = document.getElementById('custom-prompt-card');
  const customPromptText   = document.getElementById('custom-prompt-text');
  const customPromptMode   = document.getElementById('custom-prompt-mode');
  const customPromptSave   = document.getElementById('custom-prompt-save-btn');
  const customPromptClear  = document.getElementById('custom-prompt-clear-btn');
  const customPromptStatus = document.getElementById('custom-prompt-status');
  const customPromptProHint = document.getElementById('custom-prompt-pro-hint');
  const customPromptControls = document.getElementById('custom-prompt-controls');
  const semanticSearchCard     = document.getElementById('semantic-search-card');
  const semanticSearchToggle   = document.getElementById('semantic-search-toggle');
  const semanticSearchProHint  = document.getElementById('semantic-search-pro-hint');
  const semanticSearchControls = document.getElementById('semantic-search-controls');
  const semanticSearchStatus   = document.getElementById('semantic-search-status');
  const syncCard        = document.getElementById('sync-card');
  const syncToggle      = document.getElementById('sync-toggle');
  const syncProHint     = document.getElementById('sync-pro-hint');
  const syncControls    = document.getElementById('sync-controls');
  const syncStatus      = document.getElementById('sync-status');
  const syncPushBtn     = document.getElementById('sync-push-btn');
  const syncPullBtn     = document.getElementById('sync-pull-btn');
  const syncLastTime    = document.getElementById('sync-last-time');
  const syncPassphrase  = document.getElementById('sync-passphrase');
  const syncExportBtn   = document.getElementById('sync-export-btn');
  const syncImportBtn   = document.getElementById('sync-import-btn');
  const syncImportFile  = document.getElementById('sync-import-file');
  const gdriveCard         = document.getElementById('gdrive-card');
  const gdriveProHint      = document.getElementById('gdrive-pro-hint');
  const gdriveControls     = document.getElementById('gdrive-controls');
  const gdrivePassphrase   = document.getElementById('gdrive-passphrase');
  const gdriveBackupBtn    = document.getElementById('gdrive-backup-btn');
  const gdriveListBtn      = document.getElementById('gdrive-list-btn');
  const gdriveDisconnectBtn = document.getElementById('gdrive-disconnect-btn');
  const gdriveBackupList   = document.getElementById('gdrive-backup-list');
  const gdriveBackupItems  = document.getElementById('gdrive-backup-items');
  const gdriveStatus       = document.getElementById('gdrive-status');

  // ── State ─────────────────────────────────────────────────────────────────

  let selectedProvider = null;
  let debounceTimer    = null;
  let isProUser        = false;
  const syncManager    = new SyncManager();

  // ── Init ──────────────────────────────────────────────────────────────────

  /**
   * Initialize the options page: apply translations, restore persisted settings,
   * bind event listeners, load pro status, and populate all dynamic UI sections
   * (models, usage stats, debug log, domain lists, custom prompts).
   * Called once on DOMContentLoaded via the module's IIFE.
   * @returns {Promise<void>}
   */
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

    const restartObBtn = document.getElementById('restart-onboarding-btn');
    const obStatus = document.getElementById('onboarding-status');
    if (restartObBtn) {
      restartObBtn.addEventListener('click', async () => {
        await resetOnboarding();
        if (obStatus) showStatus(obStatus, 'ok', '\u2713 ' + msg('OPT_ONBOARDING_RESET'));
      });
    }

    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_PAYMENT_PAGE' });
      });
    }

    initTheme();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.omni_pro_status) {
        isProUser = changes.omni_pro_status.newValue === true;
        updateProUI();
      }
      if (area === 'sync' && changes.theme) {
        applyTheme(changes.theme.newValue || 'system');
      }
    });

    if (usageRefreshBtn) usageRefreshBtn.addEventListener('click', refreshUsageStats);
    if (usageResetBtn) usageResetBtn.addEventListener('click', resetUsageData);

    setupExclusionPinning();
    setupCustomPrompt();
    setupSemanticSearch();
    setupSync();
    setupGDriveBackup();

    refreshHistorySize();
    refreshDebugLog();
    refreshUsageStats();
  }

  // ── Provider selection ────────────────────────────────────────────────────

  /**
   * Select and activate a provider in the options UI.
   * Highlights the chosen provider button, updates key hints and placeholder text,
   * and optionally triggers model fetching if an API key is already entered.
   * Blocks selection of Pro-only providers for free-tier users.
   * @param {string} provider  Provider identifier (e.g. 'openai', 'groq').
   * @param {boolean} triggerFetch  Whether to immediately fetch models if a key exists.
   */
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

  /**
   * Fetch and populate the model dropdown for a given provider.
   * Attempts a live API call first; on failure, falls back to the hardcoded
   * model list from PROVIDER_MODELS. Updates the model indicator accordingly.
   * @param {string} provider  Provider identifier (e.g. 'openai', 'gemini').
   * @param {string} apiKey  User's API key for authenticating the models request.
   * @returns {Promise<void>}
   */
  async function loadModels(provider, apiKey) {
    setModelState('loading');
    try {
      const models = await fetchModelsFromAPI(provider, apiKey);
      populateModelSelect(models, false);
    } catch (err) {
      errorLogger.log('options:loadModels', err);
      populateModelSelect(PROVIDER_MODELS[provider] || [], true);
    }
  }

  /**
   * Set the model <select> to a placeholder state (empty or loading).
   * Clears all existing options and shows an appropriate message.
   * @param {'empty'|'loading'} state  Desired placeholder state.
   */
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

  /**
   * Populate the model <select> with fetched or fallback model IDs.
   * Restores previously selected model if it's still in the list.
   * Updates the model indicator to show success count or fallback warning.
   * @param {string[]} models  Array of model ID strings to display as options.
   * @param {boolean} isFallback  Whether these are hardcoded fallbacks (API fetch failed).
   */
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

  /**
   * Update the inline model indicator text and style class.
   * @param {string} type  Indicator type: 'loading', 'warn', 'ok', or '' to hide.
   * @param {string} msg  Human-readable indicator message text.
   */
  function setModelIndicator(type, msg) {
    if (!modelIndicator) return;
    modelIndicator.textContent = msg;
    modelIndicator.className = 'model-indicator' + (msg ? ' visible ' + type : '');
  }

  // ── API fetch ─────────────────────────────────────────────────────────────

  /**
   * Fetch the list of available models from a provider's API.
   * Filters out non-chat models (embeddings, TTS, etc.) and sorts by priority.
   * @param {string} provider  Provider key (e.g. 'openai', 'gemini').
   * @param {string} apiKey  User's API key for authentication.
   * @returns {Promise<string[]>} Sorted array of model IDs available for chat.
   * @throws {Error} On HTTP errors or if provider has no public models endpoint.
   */
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

  /**
   * Sort model IDs by provider-specific priority (best/newest first).
   * Models matching an earlier entry in MODEL_PRIORITY rank higher.
   * Models not matching any priority pattern are sorted reverse-alphabetically
   * and placed after all prioritized models.
   * Within the same priority tier, reverse-alpha (newer versions first).
   * @param {string} provider  Provider key (e.g. 'openai', 'anthropic').
   * @param {string[]} models  Unsorted array of model ID strings.
   * @returns {string[]} New array of model IDs sorted by priority descending.
   */
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

  /**
   * Persist the current provider, API key, and model selection to chrome.storage.local.
   * Validates that a provider is selected and an API key is entered before saving.
   * Disables the save button during the async write to prevent double-clicks.
   * Shows a success/error status message via showStatus() after completion.
   * @returns {Promise<void>}
   */
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

  /**
   * Test the current provider/API key combination by sending a probe request
   * through the background service worker. Validates that a provider is selected
   * and an API key is entered before initiating the test. Disables the test
   * button during the async round-trip to prevent duplicate requests.
   * Displays a success/error status message via showStatus() on completion.
   * @returns {Promise<void>}
   */
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

  /**
   * Test a provider connection by opening a chrome.runtime port to the
   * background service worker and sending a TEST_CONNECTION message.
   * Persists the given settings to chrome.storage.local first so the
   * background worker picks them up. Uses a 15-second timeout as a
   * guard against unresponsive service workers.
   * @param {{provider: string, apiKey: string, model: string}} settings
   *   Provider configuration to persist and test against.
   * @returns {Promise<{ok: boolean, error?: string}>} Test result from the
   *   background worker, or a rejected promise on timeout/disconnect.
   */
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

  /**
   * Trigger a full re-index of all open tabs by sending a REINDEX_ALL message
   * to the background service worker. Displays progress and the resulting
   * tab count to the user. Disables the button during the operation.
   * @returns {Promise<void>}
   */
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

  /**
   * Fetch and display the current chat history storage size.
   * Sends a GET_HISTORY_SIZE message to the background worker and renders
   * the session count and size in MB. Shows a warning banner when storage
   * exceeds 50 MB.
   * @returns {Promise<void>}
   */
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
      errorLogger.log('options:refreshHistorySize', err);
      storageSizeText.textContent = msg('OPT_SIZE_ERROR');
    }
  }

  /**
   * Delete all saved chat history after user confirmation.
   * Sends a CLEAR_HISTORY message to the background service worker.
   * Uses window.confirm() as a destructive-action safeguard.
   * @returns {Promise<void>}
   */
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

  // ── Token Usage Stats ──────────────────────────────────────────────────────

  /**
   * Fetch and render token usage statistics for today and the past 7 days.
   * Queries the background worker for daily/weekly usage data and cost estimates,
   * then populates the usage dashboard with formatted token counts and
   * per-provider/model breakdowns. Fails gracefully on errors.
   * @returns {Promise<void>}
   */
  async function refreshUsageStats() {
    if (!usageToday) return;
    try {
      const [daily, weekly] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_DAILY_USAGE' }),
        chrome.runtime.sendMessage({ type: 'GET_WEEKLY_USAGE' })
      ]);

      usageToday.textContent = `${daily.queries} queries · ${fmtTokens(daily.input)} in / ${fmtTokens(daily.output)} out`;
      usageWeekly.textContent = `${weekly.queries} queries · ${fmtTokens(weekly.input)} in / ${fmtTokens(weekly.output)} out`;

      if (weekly.cost && weekly.cost.total > 0) {
        usageCost.textContent = `~$${weekly.cost.total.toFixed(4)}`;
      } else {
        usageCost.textContent = 'N/A (model not in price list)';
      }

      if (usageBreakdown && Object.keys(weekly.providers).length > 0) {
        let html = '';
        for (const [prov, models] of Object.entries(weekly.providers)) {
          html += `<div class="usage-provider-name">${escHtml(prov)}</div>`;
          for (const [modelName, stats] of Object.entries(models)) {
            html += `<div class="usage-model-row">${escHtml(modelName)}: ${stats.queries} queries · ${fmtTokens(stats.input)} in / ${fmtTokens(stats.output)} out</div>`;
          }
        }
        usageBreakdown.innerHTML = html;
      } else if (usageBreakdown) {
        usageBreakdown.innerHTML = '<div style="color:var(--oc-text-muted);font-size:12px;">No usage data yet</div>';
      }
    } catch (err) {
      errorLogger.log('options:refreshUsageStats', err);
      if (usageToday) usageToday.textContent = 'Error loading';
    }
  }

  /**
   * Reset all accumulated token usage data after user confirmation.
   * Irreversible — sends a RESET_USAGE message to the background worker and
   * refreshes the usage display. Disables the button during the operation.
   * @returns {Promise<void>}
   */
  async function resetUsageData() {
    if (!confirm('Reset all token usage data? This cannot be undone.')) return;
    if (usageResetBtn) usageResetBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'RESET_USAGE' });
      showStatus(usageStatus, 'ok', '✓ Usage data reset');
      refreshUsageStats();
    } catch (err) {
      showStatus(usageStatus, 'err', 'Error: ' + err.message);
    } finally {
      if (usageResetBtn) usageResetBtn.disabled = false;
    }
  }

  /**
   * Format a token count into a human-readable abbreviated string.
   * Uses 'M' suffix for millions, 'k' for thousands, plain number otherwise.
   * @param {number} n  Raw token count (non-negative integer).
   * @returns {string} Formatted string, e.g. "1.25M", "45.3k", or "892".
   */
  function fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  // ── ChatGPT OAuth (PKCE, behind feature flag) ──────────────────────────────

  // Feature flag: chatgptOAuthEnabled must be true in storage to show this UI.
  // OAuth endpoints and PKCE flow are handled entirely by the background worker
  // (see background.js handleOAuthStart). This UI only triggers the flow via messages.

  /**
   * Initialize the ChatGPT OAuth UI section (behind feature flag).
   * Checks chrome.storage.local for an existing OAuth session and toggles
   * connected/disconnected UI states. Binds login and disconnect button
   * handlers that delegate to the background worker's OAUTH_START/OAUTH_DISCONNECT
   * message handlers. Only visible when chatgptOAuthEnabled is true in storage.
   */
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

  // ── Exclusion & Pinning management ─────────────────────────────────────────

  /**
   * Initialize the domain exclusion and pinning UI section.
   * Binds click and Enter-key handlers for the add-domain buttons/inputs,
   * loads existing domain lists, and listens for chrome.storage.sync changes
   * to keep the UI in sync with changes made from other tabs or the background.
   */
  function setupExclusionPinning() {
    if (addExcludedBtn) {
      addExcludedBtn.addEventListener('click', () => addDomain('excluded'));
      excludedInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addDomain('excluded');
      });
    }
    if (addPinnedBtn) {
      addPinnedBtn.addEventListener('click', () => addDomain('pinned'));
      pinnedInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addDomain('pinned');
      });
    }
    refreshDomainLists();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && (changes.excludedDomains || changes.pinnedDomains)) {
        refreshDomainLists();
      }
    });
  }

  /**
   * Reload both excluded and pinned domain lists from chrome.storage.sync
   * and re-render them in the DOM. Called on init and whenever storage changes.
   * @returns {Promise<void>}
   */
  async function refreshDomainLists() {
    const result = await chrome.storage.sync.get(['excludedDomains', 'pinnedDomains']);
    renderDomainList(excludedListEl, result.excludedDomains || [], 'excluded');
    renderDomainList(pinnedListEl, result.pinnedDomains || [], 'pinned');
  }

  /**
   * Render a list of domain patterns into a container element.
   * Clears existing content and creates a removable pill for each domain.
   * Shows an empty-state message when the list is empty.
   * @param {HTMLElement|null} container  DOM element to render into (no-op if null).
   * @param {string[]} domains  Array of domain pattern strings to display.
   * @param {'excluded'|'pinned'} listType  Which list type, used for i18n keys and remove handler.
   */
  function renderDomainList(container, domains, listType) {
    if (!container) return;
    container.innerHTML = '';
    if (domains.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'domain-empty';
      empty.textContent = msg(listType === 'excluded' ? 'OPT_EXCLUDED_EMPTY' : 'OPT_PINNED_EMPTY');
      container.appendChild(empty);
      return;
    }
    domains.forEach(domain => {
      const item = document.createElement('div');
      item.className = 'domain-list-item';

      const name = document.createElement('span');
      name.className = 'domain-name';
      name.textContent = domain;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'domain-remove-btn';
      removeBtn.textContent = '\u00D7';
      removeBtn.addEventListener('click', () => removeDomain(listType, domain));

      item.appendChild(name);
      item.appendChild(removeBtn);
      container.appendChild(item);
    });
  }

  /**
   * Add a domain pattern to the excluded or pinned list.
   * Reads the value from the corresponding input element, deduplicates against
   * the existing list in chrome.storage.sync, and notifies the background worker
   * for immediate effect (exclusion only). Clears the input on success.
   * @param {'excluded'|'pinned'} listType  Which domain list to add to.
   * @returns {Promise<void>}
   */
  async function addDomain(listType) {
    const input = listType === 'excluded' ? excludedInput : pinnedInput;
    const value = input.value.trim();
    if (!value) return;

    const storageKey = listType === 'excluded' ? 'excludedDomains' : 'pinnedDomains';
    const result = await chrome.storage.sync.get(storageKey);
    const domains = result[storageKey] || [];
    if (domains.includes(value)) { input.value = ''; return; }

    domains.push(value);
    await chrome.storage.sync.set({ [storageKey]: domains });

    if (listType === 'excluded') {
      chrome.runtime.sendMessage({ type: 'EXCLUDE_DOMAIN', domain: value });
    }

    input.value = '';
    refreshDomainLists();
  }

  /**
   * Remove a domain pattern from the excluded or pinned list.
   * Sends a message to the background service worker which handles the actual
   * storage update and re-indexing. The storage change listener triggers a
   * UI refresh automatically.
   * @param {'excluded'|'pinned'} listType  Which domain list to remove from.
   * @param {string} domain  The domain pattern to remove (exact match).
   * @returns {Promise<void>}
   */
  async function removeDomain(listType, domain) {
    const msgType = listType === 'excluded' ? 'UNEXCLUDE_DOMAIN' : 'UNPIN_DOMAIN';
    chrome.runtime.sendMessage({ type: msgType, domain });
  }

  // ── Custom System Prompt ────────────────────────────────────────────────────

  const PROMPT_PRESETS = {
    'code-review': `You are a senior code reviewer. Analyze the code in the provided tabs with focus on:
- Bugs and potential runtime errors
- Security vulnerabilities
- Performance issues
- Code style and best practices
Rate severity (critical/warning/info) for each finding. Cite the source tab for every issue.`,

    'legal': `You are a legal analysis assistant. When reviewing documents from the provided tabs:
- Identify key legal terms, clauses, and obligations
- Flag potential risks or ambiguities
- Compare terms across documents if multiple are provided
- Note any missing standard clauses
Always cite the specific document tab. This is not legal advice.`,

    'academic': `You are an academic research assistant. Analyze the provided tabs as research sources:
- Evaluate methodology and evidence quality
- Identify consensus and disagreements between sources
- Note citation gaps and areas needing further research
- Summarize key findings with proper attribution
Use formal academic tone. Cite each tab as a source.`,

    'summarizer': `Provide a concise executive summary of the content across all tabs.
For each tab, write a 2-3 sentence summary of key points.
End with an overall synthesis of no more than 5 bullet points.
Keep it brief and actionable.`
  };

  /**
   * Initialize the custom system prompt configuration UI.
   * Loads saved prompt text/mode from chrome.storage.sync, binds save/clear/preset
   * buttons, and applies Pro-tier visibility gating on controls.
   */
  function setupCustomPrompt() {
    if (!customPromptCard) return;

    loadCustomPromptSettings();

    if (customPromptSave) {
      customPromptSave.addEventListener('click', saveCustomPrompt);
    }
    if (customPromptClear) {
      customPromptClear.addEventListener('click', clearCustomPrompt);
    }

    customPromptCard.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const presetText = PROMPT_PRESETS[btn.dataset.preset];
        if (presetText && customPromptText) {
          customPromptText.value = presetText;
          customPromptMode.value = 'suffix';
        }
      });
    });

    updateCustomPromptProUI();
  }

  /**
   * Load saved custom prompt text and mode from chrome.storage.sync
   * and populate the corresponding form fields. Fails silently on
   * storage read errors (logs to error ring buffer for debugging).
   * @returns {Promise<void>}
   */
  async function loadCustomPromptSettings() {
    try {
      const result = await chrome.storage.sync.get(['customPromptText', 'customPromptMode']);
      if (customPromptText && result.customPromptText) {
        customPromptText.value = result.customPromptText;
      }
      if (customPromptMode && result.customPromptMode) {
        customPromptMode.value = result.customPromptMode;
      }
    } catch (err) {
      errorLogger.log('options:loadCustomPromptSettings', err);
    }
  }

  /**
   * Persist the current custom prompt text and mode to chrome.storage.sync.
   * Disables the save button during the async write to prevent double-clicks.
   * Shows a success/error status message on completion.
   * @returns {Promise<void>}
   */
  async function saveCustomPrompt() {
    if (!customPromptText) return;
    if (customPromptSave) customPromptSave.disabled = true;
    try {
      await chrome.storage.sync.set({
        customPromptText: customPromptText.value,
        customPromptMode: customPromptMode?.value || 'suffix'
      });
      showStatus(customPromptStatus, 'ok', '\u2713 ' + msg('OPT_CUSTOM_PROMPT_SAVED'));
    } catch (err) {
      showStatus(customPromptStatus, 'err', msg('ERROR_PREFIX') + err.message);
    } finally {
      if (customPromptSave) customPromptSave.disabled = false;
    }
  }

  /**
   * Clear the custom prompt by resetting form fields to defaults and
   * removing the customPromptText/customPromptMode keys from chrome.storage.sync.
   * Shows a confirmation status message on completion.
   * @returns {Promise<void>}
   */
  async function clearCustomPrompt() {
    if (customPromptText) customPromptText.value = '';
    if (customPromptMode) customPromptMode.value = 'suffix';
    try {
      await chrome.storage.sync.remove(['customPromptText', 'customPromptMode']);
      showStatus(customPromptStatus, 'ok', '\u2713 ' + msg('OPT_CUSTOM_PROMPT_CLEARED'));
    } catch (err) {
      showStatus(customPromptStatus, 'err', msg('ERROR_PREFIX') + err.message);
    }
  }

  /**
   * Toggle the custom prompt controls visibility based on Pro subscription status.
   * Pro users see full controls; free-tier users see a greyed-out state with a
   * Pro upgrade hint. Applied on init and when subscription status changes.
   */
  function updateCustomPromptProUI() {
    if (!customPromptCard) return;
    if (isProUser) {
      if (customPromptProHint) customPromptProHint.classList.add('hidden');
      if (customPromptControls) {
        customPromptControls.style.opacity = '';
        customPromptControls.style.pointerEvents = '';
      }
    } else {
      if (customPromptProHint) customPromptProHint.classList.remove('hidden');
      if (customPromptControls) {
        customPromptControls.style.opacity = '0.45';
        customPromptControls.style.pointerEvents = 'none';
      }
    }
  }

  // ── Semantic Search ─────────────────────────────────────────────────────────

  /**
   * Initialize the semantic search (embeddings) toggle UI.
   * Loads the current enabled state from chrome.storage.sync, binds the toggle
   * change handler, and applies Pro-tier visibility gating.
   */
  function setupSemanticSearch() {
    if (!semanticSearchCard) return;

    loadSemanticSearchSetting();

    if (semanticSearchToggle) {
      semanticSearchToggle.addEventListener('change', async () => {
        try {
          await chrome.storage.sync.set({ semanticSearchEnabled: semanticSearchToggle.checked });
          showStatus(semanticSearchStatus, 'ok', semanticSearchToggle.checked ? '\u2713 Semantic search enabled' : '\u2713 Semantic search disabled');
        } catch (err) {
          showStatus(semanticSearchStatus, 'err', 'Error: ' + err.message);
        }
      });
    }

    updateSemanticSearchProUI();
  }

  /**
   * Load the semantic search enabled state from chrome.storage.sync and
   * set the toggle checkbox accordingly. Fails silently on storage errors.
   * @returns {Promise<void>}
   */
  async function loadSemanticSearchSetting() {
    try {
      const result = await chrome.storage.sync.get('semanticSearchEnabled');
      if (semanticSearchToggle) {
        semanticSearchToggle.checked = result.semanticSearchEnabled === true;
      }
    } catch (err) {
      errorLogger.log('options:loadSemanticSearchSetting', err);
    }
  }

  /**
   * Toggle the semantic search controls visibility based on Pro subscription status.
   * Pro users see full controls; free-tier users see a greyed-out state with a
   * Pro upgrade hint. Applied on init and when subscription status changes.
   */
  function updateSemanticSearchProUI() {
    if (!semanticSearchCard) return;
    if (isProUser) {
      if (semanticSearchProHint) semanticSearchProHint.classList.add('hidden');
      if (semanticSearchControls) {
        semanticSearchControls.style.opacity = '';
        semanticSearchControls.style.pointerEvents = '';
      }
    } else {
      if (semanticSearchProHint) semanticSearchProHint.classList.remove('hidden');
      if (semanticSearchControls) {
        semanticSearchControls.style.opacity = '0.45';
        semanticSearchControls.style.pointerEvents = 'none';
      }
    }
  }

  // ── Cross-Device Sync ──────────────────────────────────────────────────────

  /**
   * Initialize the cross-device sync UI section.
   * Loads the SyncManager state, binds toggle/push/pull/export/import event handlers,
   * and applies Pro-tier visibility gating. Manages encrypted history export/import
   * via file download/upload with passphrase-based AES-GCM encryption.
   * @returns {Promise<void>}
   */
  async function setupSync() {
    if (!syncCard) return;

    await syncManager.init();

    if (syncToggle) {
      syncToggle.checked = syncManager.enabled;
      syncToggle.addEventListener('change', async () => {
        try {
          await syncManager.setEnabled(syncToggle.checked);
          showStatus(syncStatus, 'ok', syncToggle.checked ? '\u2713 Sync enabled' : '\u2713 Sync disabled');
          updateSyncLastTime();
        } catch (err) {
          showStatus(syncStatus, 'err', 'Error: ' + err.message);
        }
      });
    }

    if (syncPushBtn) {
      syncPushBtn.addEventListener('click', async () => {
        syncPushBtn.disabled = true;
        showStatus(syncStatus, 'info', 'Pushing settings...');
        const result = await syncManager.pushSettings();
        syncPushBtn.disabled = false;
        if (result.ok) {
          showStatus(syncStatus, 'ok', '\u2713 Settings pushed to sync');
          updateSyncLastTime();
        } else {
          showStatus(syncStatus, 'err', result.error || 'Push failed');
        }
      });
    }

    if (syncPullBtn) {
      syncPullBtn.addEventListener('click', async () => {
        syncPullBtn.disabled = true;
        showStatus(syncStatus, 'info', 'Pulling settings...');
        const result = await syncManager.pullSettings();
        syncPullBtn.disabled = false;
        if (result.ok && result.applied) {
          showStatus(syncStatus, 'ok', '\u2713 Settings pulled and applied');
          updateSyncLastTime();
        } else if (result.ok) {
          showStatus(syncStatus, 'ok', 'Already up to date');
        } else {
          showStatus(syncStatus, 'err', result.error || 'Pull failed');
        }
      });
    }

    if (syncExportBtn) {
      syncExportBtn.addEventListener('click', async () => {
        const pass = syncPassphrase?.value;
        if (!pass) { showStatus(syncStatus, 'err', 'Enter a passphrase first'); return; }
        syncExportBtn.disabled = true;
        const result = await syncManager.exportHistory(pass);
        syncExportBtn.disabled = false;
        if (result.ok) {
          const url = URL.createObjectURL(result.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `omni-context-history-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          showStatus(syncStatus, 'ok', '\u2713 History exported');
        } else {
          showStatus(syncStatus, 'err', result.error || 'Export failed');
        }
      });
    }

    if (syncImportBtn && syncImportFile) {
      syncImportBtn.addEventListener('click', () => syncImportFile.click());
      syncImportFile.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const pass = syncPassphrase?.value;
        if (!pass) { showStatus(syncStatus, 'err', 'Enter the passphrase used during export'); return; }
        syncImportBtn.disabled = true;
        try {
          const text = await file.text();
          const result = await syncManager.importHistory(text, pass);
          if (result.ok) {
            showStatus(syncStatus, 'ok', `\u2713 Imported ${result.imported} session(s)`);
          } else {
            showStatus(syncStatus, 'err', result.error || 'Import failed');
          }
        } catch (err) {
          showStatus(syncStatus, 'err', 'Error reading file: ' + err.message);
        } finally {
          syncImportBtn.disabled = false;
          syncImportFile.value = '';
        }
      });
    }

    updateSyncLastTime();
    updateSyncProUI();
  }

  /**
   * Update the "last synced" timestamp display in the sync settings UI.
   * Shows a formatted locale date string if a sync has occurred, or
   * "Not yet synced" placeholder otherwise.
   */
  function updateSyncLastTime() {
    if (!syncLastTime) return;
    const ts = syncManager.lastSyncTime;
    if (ts > 0) {
      syncLastTime.textContent = 'Last synced: ' + new Date(ts).toLocaleString();
    } else {
      syncLastTime.textContent = 'Not yet synced';
    }
  }

  /**
   * Toggle Pro-tier UI gating for the cross-device sync section.
   * When the user is Pro: hides the upgrade hint and enables controls.
   * When free-tier: shows the upgrade hint and disables controls via
   * reduced opacity and pointer-events: none.
   */
  function updateSyncProUI() {
    if (!syncCard) return;
    if (isProUser) {
      if (syncProHint) syncProHint.classList.add('hidden');
      if (syncControls) {
        syncControls.style.opacity = '';
        syncControls.style.pointerEvents = '';
      }
    } else {
      if (syncProHint) syncProHint.classList.remove('hidden');
      if (syncControls) {
        syncControls.style.opacity = '0.45';
        syncControls.style.pointerEvents = 'none';
      }
    }
  }

  // ── Google Drive Backup ──────────────────────────────────────────────────────

  function setupGDriveBackup() {
    if (!gdriveCard) return;

    if (gdriveBackupBtn) {
      gdriveBackupBtn.addEventListener('click', async () => {
        const pass = gdrivePassphrase?.value;
        if (!pass) { showStatus(gdriveStatus, 'err', 'Enter a passphrase first'); return; }
        gdriveBackupBtn.disabled = true;
        showStatus(gdriveStatus, 'info', 'Encrypting and uploading...');
        const result = await exportToGDrive(pass);
        gdriveBackupBtn.disabled = false;
        if (result.ok) {
          showStatus(gdriveStatus, 'ok', '\u2713 Backup uploaded to Google Drive');
        } else {
          showStatus(gdriveStatus, 'err', result.error || 'Backup failed');
        }
      });
    }

    if (gdriveListBtn) {
      gdriveListBtn.addEventListener('click', async () => {
        gdriveListBtn.disabled = true;
        showStatus(gdriveStatus, 'info', 'Fetching backups...');
        const result = await listBackups();
        gdriveListBtn.disabled = false;
        if (!result.ok) {
          showStatus(gdriveStatus, 'err', result.error || 'Failed to list backups');
          return;
        }
        showStatus(gdriveStatus, 'ok', `Found ${result.backups.length} backup(s)`);
        renderBackupList(result.backups);
      });
    }

    if (gdriveDisconnectBtn) {
      gdriveDisconnectBtn.addEventListener('click', async () => {
        await disconnectGDrive();
        showStatus(gdriveStatus, 'ok', '\u2713 Disconnected from Google Drive');
        if (gdriveBackupList) gdriveBackupList.style.display = 'none';
      });
    }

    updateGDriveProUI();
  }

  function renderBackupList(backups) {
    if (!gdriveBackupItems || !gdriveBackupList) return;
    if (backups.length === 0) {
      gdriveBackupItems.textContent = 'No backups found.';
      gdriveBackupList.style.display = 'block';
      return;
    }

    gdriveBackupItems.innerHTML = backups.map(b => {
      const date = new Date(b.createdTime).toLocaleString();
      const sizeKB = b.size > 0 ? `(${Math.round(b.size / 1024)} KB)` : '';
      return `<div style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid var(--oc-border, #2c2f45);">
        <span style="flex:1;">${escHtml(date)} ${sizeKB}</span>
        <button class="btn btn-secondary" style="font-size:11px; padding:2px 8px;" data-gdrive-restore="${escHtml(b.id)}">Restore</button>
        <button class="btn btn-danger" style="font-size:11px; padding:2px 8px;" data-gdrive-delete="${escHtml(b.id)}">Delete</button>
      </div>`;
    }).join('');

    gdriveBackupList.style.display = 'block';

    gdriveBackupItems.querySelectorAll('[data-gdrive-restore]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const fileId = btn.dataset.gdriveRestore;
        const pass = gdrivePassphrase?.value;
        if (!pass) { showStatus(gdriveStatus, 'err', 'Enter the passphrase used during backup'); return; }
        btn.disabled = true;
        showStatus(gdriveStatus, 'info', 'Downloading and decrypting...');
        const result = await importFromGDrive(fileId, pass);
        btn.disabled = false;
        if (result.ok) {
          showStatus(gdriveStatus, 'ok', `\u2713 Restored ${result.imported} session(s)`);
        } else {
          showStatus(gdriveStatus, 'err', result.error || 'Restore failed');
        }
      });
    });

    gdriveBackupItems.querySelectorAll('[data-gdrive-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const fileId = btn.dataset.gdriveDelete;
        btn.disabled = true;
        const result = await deleteBackup(fileId);
        if (result.ok) {
          btn.closest('div').remove();
          showStatus(gdriveStatus, 'ok', '\u2713 Backup deleted');
        } else {
          btn.disabled = false;
          showStatus(gdriveStatus, 'err', result.error || 'Delete failed');
        }
      });
    });
  }

  function updateGDriveProUI() {
    if (!gdriveCard) return;
    if (isProUser) {
      if (gdriveProHint) gdriveProHint.classList.add('hidden');
      if (gdriveControls) {
        gdriveControls.style.opacity = '';
        gdriveControls.style.pointerEvents = '';
      }
    } else {
      if (gdriveProHint) gdriveProHint.classList.remove('hidden');
      if (gdriveControls) {
        gdriveControls.style.opacity = '0.45';
        gdriveControls.style.pointerEvents = 'none';
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Show a temporary status message in a status element.
   * Applies a CSS class for visual styling (ok/err/info) and auto-hides
   * success messages after 4 seconds.
   * @param {HTMLElement} el  The status message DOM element to update.
   * @param {string} type  Status type: 'ok', 'err', or 'info' — determines styling.
   * @param {string} text  Human-readable message text to display.
   */
  function showStatus(el, type, text) {
    el.className = `status-msg visible ${type}`;
    el.textContent = text;
    if (type === 'ok') {
      setTimeout(() => { el.className = 'status-msg'; }, 4000);
    }
  }

  // ── Pro status ───────────────────────────────────────────────────────────

  /**
   * Load the user's Pro subscription status from chrome.storage.sync
   * and update all Pro-gated UI sections accordingly.
   * @returns {Promise<void>}
   */
  async function loadProStatus() {
    try {
      const result = await chrome.storage.sync.get('omni_pro_status');
      isProUser = result.omni_pro_status === true;
    } catch (err) {
      errorLogger.log('options:loadProStatus', err);
      isProUser = false;
    }
    updateProUI();
  }

  /**
   * Update all Pro-tier-gated UI elements based on the current isProUser state.
   * Toggles visibility of free/active status badges, locks Pro-only provider buttons,
   * and delegates to sub-section updaters (custom prompts, semantic search, sync, GDrive).
   */
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

    updateCustomPromptProUI();
    updateSemanticSearchProUI();
    updateSyncProUI();
    updateGDriveProUI();
  }

  // ── Debug log ──────────────────────────────────────────────────────────────

  /**
   * Load and display the error ring buffer contents in the debug log panel.
   * Shows a categorized summary header (errors grouped by source prefix) and
   * formats each entry with timestamp, source, message, and first stack frame.
   * Scrolls to the bottom to show the most recent errors.
   * @returns {Promise<void>}
   */
  async function refreshDebugLog() {
    if (!debugLogPre) return;
    await errorLogger.load();
    const entries = errorLogger.getAll();

    const summaryEl = document.getElementById('error-summary');
    const summaryContentEl = document.getElementById('error-summary-content');
    if (summaryEl && summaryContentEl) {
      if (entries.length > 0) {
        const cats = errorLogger.getCategories();
        const parts = Object.entries(cats).map(([k, v]) => `${k}: ${v}`).join(', ');
        summaryContentEl.textContent = ` \u2014 ${entries.length} ${msg('ERROR_SUMMARY_TOTAL') || 'errors'} (${parts})`;
        summaryEl.style.display = '';
      } else {
        summaryEl.style.display = 'none';
      }
    }

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

  /**
   * Clear all entries from the error ring buffer and reset the debug log display.
   * Shows a confirmation status message on completion.
   * @returns {Promise<void>}
   */
  async function clearDebugLog() {
    await errorLogger.clear();
    if (debugLogPre) debugLogPre.textContent = msg('DEBUG_LOG_EMPTY');
    if (debugLogStatus) showStatus(debugLogStatus, 'ok', '✓ ' + msg('OPT_LOG_CLEARED'));
  }

  // ── Theme ──────────────────────────────────────────────────────────────────

  async function initTheme() {
    const result = await chrome.storage.sync.get('theme');
    const theme = result.theme || 'system';
    applyTheme(theme);

    if (themeOptions) {
      const radio = themeOptions.querySelector(`input[value="${theme}"]`);
      if (radio) radio.checked = true;

      themeOptions.addEventListener('change', (e) => {
        if (e.target.name !== 'theme') return;
        const val = e.target.value;
        applyTheme(val);
        chrome.storage.sync.set({ theme: val });
      });
    }
  }

  /**
   * Apply a theme to the document by setting the data-theme attribute on <html>.
   * For 'light' or 'dark', sets the attribute explicitly to override CSS media queries.
   * For 'system' (or any other value), removes the attribute to let
   * @media (prefers-color-scheme) handle theming automatically.
   * @param {string} theme  Theme identifier: 'light', 'dark', or 'system'.
   */
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  init();
})();
