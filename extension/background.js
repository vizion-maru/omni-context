/**
 * Omni-Context background service worker.
 * All AI calls happen here — no backend, direct to provider APIs.
 */

import { Indexer } from './lib/indexer.js';
import { createProvider, testProvider } from './lib/providers.js';
import { extractPdfText } from './lib/pdf-extractor.js';
import { FeatureGate } from './lib/feature-gates.js';
import { openPaymentPage } from './lib/extpay.js';
import { errorLogger } from './lib/error-logger.js';
import { trackUsage, getDailyUsage, getWeeklyUsage, getCostEstimate, resetUsage, getModelContextLimit } from './lib/token-tracker.js';
import { estimateTokens } from './lib/utils.js';
import { generateEmbedding, getEmbeddingConfig } from './lib/embeddings.js';
import { SyncManager } from './lib/sync.js';

const indexer = new Indexer();
const syncManager = new SyncManager();
const chatPorts = new Set();

// Active stream AbortControllers per port (for cancel support)
const activeStreams = new WeakMap();

// Restore persisted index, init feature gates, then prune stale tabs
errorLogger.load().then(() => {
  indexer.restore()
    .then(async () => {
      await FeatureGate.init();
      await syncManager.init();
      const sizeBefore = indexer.size();
      await indexer.reconcile();
      if (indexer.size() < sizeBefore) { await indexer.persist(); _dirtySet.clear(); }

      // Crash recovery: heartbeat existed but index empty → SW crashed mid-session
      const session = await chrome.storage.session.get(_HEARTBEAT_KEY);
      if (session[_HEARTBEAT_KEY] && indexer.size() === 0) {
        const tabs = await chrome.tabs.query({});
        const contentTabs = tabs.filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
        if (contentTabs.length > 0) {
          errorLogger.log('background:crashRecovery', `SW crash detected, reindexing ${contentTabs.length} tabs`);
          await reindexAllTabs(true);
        }
      }

      broadcastTabCount();
    })
    .catch((err) => { errorLogger.log('background:startup', err); });
});

// ── Crash recovery heartbeat ──────────────────────────────────────────────────
const _HEARTBEAT_KEY = '_oc_sw_heartbeat';
const _HEARTBEAT_INTERVAL_MS = 25000;

/** Write heartbeat to session storage so we can detect SW crashes. */
function _writeHeartbeat() {
  chrome.storage.session.set({ [_HEARTBEAT_KEY]: Date.now() }).catch(() => {});
}
setInterval(_writeHeartbeat, _HEARTBEAT_INTERVAL_MS);
_writeHeartbeat();

// ── Service worker lifecycle recovery ─────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
  try {
    await errorLogger.load();
    await indexer.restore();
    await FeatureGate.init();
    await syncManager.init();
    const sizeBefore = indexer.size();
    await indexer.reconcile();
    if (indexer.size() < sizeBefore) { await indexer.persist(); _dirtySet.clear(); }
    broadcastTabCount();
  } catch (err) {
    errorLogger.log('background:onStartup', err);
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    if (details.reason === 'update') {
      await errorLogger.load();
      await indexer.restore();
      await indexer.reconcile();
      broadcastTabCount();
      errorLogger.log('background:onInstalled', `Updated to v${chrome.runtime.getManifest().version}`);
    }
  } catch (err) {
    errorLogger.log('background:onInstalled', err);
  }
});

// ── Sync: auto-push on settings changes ───────────────────────────────────────
const _SYNC_WATCHED_LOCAL_KEYS = new Set(['provider', 'model', 'embeddingEndpoint', 'embeddingModel']);
const _SYNC_WATCHED_SYNC_KEYS = new Set(['theme', 'excludedDomains', 'pinnedDomains', 'customPromptText', 'customPromptMode', 'semanticSearchEnabled']);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    const relevant = Object.keys(changes).some(k => _SYNC_WATCHED_LOCAL_KEYS.has(k));
    if (relevant) syncManager.schedulePush();
  } else if (areaName === 'sync') {
    const relevant = Object.keys(changes).some(k => _SYNC_WATCHED_SYNC_KEYS.has(k));
    if (relevant) syncManager.schedulePush();
  }
});

// ── Debounced persistence ──────────────────────────────────────────────────────
let _persistTimer = null;
const _dirtySet = new Set();

/**
 * Schedule a debounced persist of the index for the given tab.
 * Batches multiple dirty tabs over a 2-second window before flushing to storage.
 * On persist failure, re-adds the dirty IDs for retry on the next cycle.
 * @param {number|null} tabId  Tab ID that changed (null to just trigger flush).
 */
function schedulePersist(tabId) {
  if (tabId != null) _dirtySet.add(tabId);
  if (_persistTimer !== null) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    if (_dirtySet.size === 0) return;
    const dirty = new Set(_dirtySet);
    _dirtySet.clear();
    try {
      await indexer.persistDirty(dirty);
    } catch (err) {
      for (const id of dirty) _dirtySet.add(id);
      if (Indexer.isQuotaError(err)) {
        errorLogger.log('background:quotaExceeded', err);
        for (const p of chatPorts) {
          try { p.postMessage({ type: 'QUOTA_WARNING' }); } catch (err) { errorLogger.log('background:broadcastQuotaWarning', err); }
        }
      }
    }
  }, 2000);
}

// ── Auto-reindex tracking ──────────────────────────────────────────────────────
let lastIndexedAt = Date.now();
/** @type {Map<number, string>} tabId → last-indexed URL */
const tabLastUrl = new Map();

/**
 * Update the lastIndexedAt timestamp to the current time.
 * Called after any successful indexing pass so the UI can display freshness.
 */
function markIndexed() {
  lastIndexedAt = Date.now();
}

// Reindex tabs every 5 minutes (only re-extracts tabs whose URL changed)
setInterval(async () => {
  await reindexAllTabs();
  markIndexed();
}, 300_000);

// ── Action click → open side panel ────────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ── Tab content indexing ───────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;
  await extractAndIndex(tabId, tab);
  generateTabEmbedding(tabId);
  markIndexed();
  broadcastTabCount();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;
  setTimeout(async () => {
    await extractAndIndex(tab.id);
    generateTabEmbedding(tab.id);
    markIndexed();
    broadcastTabCount();
  }, 3000);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  indexer.remove(tabId);
  tabLastUrl.delete(tabId);
  schedulePersist(tabId);
  broadcastTabCount();
});

/**
 * Check if a URL points to a PDF file based on its pathname extension.
 * @param {string} url  URL to check.
 * @returns {boolean} True if the URL pathname ends with '.pdf' (case-insensitive).
 */
function isPdfUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch (err) {
    errorLogger.log('background:isPdfUrl', err);
    return false;
  }
}

// ── Tab exclusion & pinning ────────────────────────────────────────────────────

/**
 * Check whether a hostname matches a domain pattern.
 * Supports wildcard prefix (e.g. "*.google.com" matches "mail.google.com")
 * and exact match (e.g. "example.com" matches only "example.com").
 * @param {string} hostname  The hostname to test.
 * @param {string} pattern   Domain pattern — optionally prefixed with "*.".
 * @returns {boolean}
 */
function matchesDomainPattern(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith('.' + suffix);
  }
  return h === p;
}

/**
 * Get the list of excluded domain patterns from chrome.storage.sync.
 * @returns {Promise<string[]>}
 */
async function getExcludedDomains() {
  const result = await chrome.storage.sync.get('excludedDomains');
  return result.excludedDomains || [];
}

/**
 * Get the list of pinned domain patterns from chrome.storage.sync.
 * @returns {Promise<string[]>}
 */
async function getPinnedDomains() {
  const result = await chrome.storage.sync.get('pinnedDomains');
  return result.pinnedDomains || [];
}

/**
 * Check if a URL's hostname matches any of the given domain patterns.
 * @param {string} url  Full URL to check.
 * @param {string[]} patterns  Domain patterns to test against.
 * @returns {boolean}
 */
function isHostnameMatched(url, patterns) {
  if (!url || patterns.length === 0) return false;
  try {
    const hostname = new URL(url).hostname;
    return patterns.some(p => matchesDomainPattern(hostname, p));
  } catch (err) {
    errorLogger.log('background:isHostnameMatched', err);
    return false;
  }
}

/**
 * Extract content from a tab and add it to the search index.
 * Attempts extraction in order: PDF.js (for PDFs), content script message,
 * programmatic content script injection + retry, and finally tab metadata fallback.
 * Respects the free-tier tab limit via FeatureGate.canIndexTab().
 * @param {number} tabId  Chrome tab ID to extract and index.
 * @param {chrome.tabs.Tab|null} [tab=null]  Pre-fetched tab object to avoid redundant chrome.tabs.get().
 * @returns {Promise<void>}
 */
async function extractAndIndex(tabId, tab = null) {
  if (!FeatureGate.canIndexTab(indexer.size())) return;

  if (!tab) {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (err) {
      errorLogger.log('background:extractAndIndex:getTab', err);
      return;
    }
  }

  const tabUrl = tab.url;

  const excluded = await getExcludedDomains();
  if (isHostnameMatched(tabUrl, excluded)) return;

  if (tabUrl && isPdfUrl(tabUrl)) {
    try {
      const { title, url, content } = await extractPdfText(tabUrl);
      indexer.upsert(tabId, { title, url, content });
      tabLastUrl.set(tabId, tabUrl);
      schedulePersist(tabId);
    } catch (pdfErr) {
      errorLogger.log('background:extractAndIndex:pdf', pdfErr);
      if (tab.title && tab.url) {
        indexer.upsert(tabId, { title: tab.title, url: tab.url, content: '' });
        tabLastUrl.set(tabId, tab.url);
        schedulePersist(tabId);
      }
    }
    return;
  }

  // Try sending to already-injected content script
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_CONTENT' });
    if (response?.ok) {
      indexer.upsert(tabId, { title: response.title, url: response.url, content: response.content });
      tabLastUrl.set(tabId, response.url);
      schedulePersist(tabId);
      return;
    }
  } catch (err) {
    errorLogger.log('background:extractAndIndex:sendMessage', err);
    // Content script not yet injected. Inject programmatically and retry once.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 300));
      const response = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_CONTENT' });
      if (response?.ok) {
        indexer.upsert(tabId, { title: response.title, url: response.url, content: response.content });
        tabLastUrl.set(tabId, response.url);
        schedulePersist(tabId);
        return;
      }
    } catch (err) { errorLogger.log('background:extractAndIndex:injectRetry', err); }
  }

  // Final fallback: index tab metadata only
  if (tab.title && tab.url) {
    indexer.upsert(tabId, { title: tab.title, url: tab.url, content: '' });
    tabLastUrl.set(tabId, tab.url);
    schedulePersist(tabId);
  }
}

/**
 * Generate and store an embedding for a tab's content.
 * Only runs if user is Pro with an embedding-capable provider configured.
 * Runs async (fire-and-forget) to avoid blocking the indexing flow.
 * @param {number} tabId
 */
async function generateTabEmbedding(tabId) {
  if (!FeatureGate.canUseSemanticSearch()) return;

  const semanticResult = await chrome.storage.sync.get('semanticSearchEnabled');
  if (!semanticResult.semanticSearchEnabled) return;

  const entry = indexer._index.get(tabId);
  if (!entry || entry.embedding) return;

  const settings = await getSettings();
  const embeddingConfig = getEmbeddingConfig(settings);
  if (!embeddingConfig) return;

  const textToEmbed = (entry.title + ' ' + entry.content).slice(0, 32000);
  const embedding = await generateEmbedding(textToEmbed, embeddingConfig);
  if (embedding) {
    indexer.setEmbedding(tabId, embedding);
    schedulePersist(tabId);
  }
}

// ── Settings helpers ───────────────────────────────────────────────────────────

/**
 * Retrieve extension settings (provider, API key, model, OAuth tokens) from chrome.storage.local.
 * @returns {Promise<import('./types/messages').SettingsResponse>}
 */
async function getSettings() {
  const result = await chrome.storage.local.get([
    'provider', 'apiKey', 'model',
    'oauthProvider', 'oauthAccessToken', 'oauthRefreshToken', 'oauthTokenExpiry',
    'embeddingEndpoint', 'embeddingModel'
  ]);
  return {
    provider: result.provider || null,
    apiKey:   result.apiKey   || null,
    model:    result.model    || null,
    // OAuth fields
    oauthProvider:      result.oauthProvider      || null,
    oauthAccessToken:   result.oauthAccessToken   || null,
    oauthRefreshToken:  result.oauthRefreshToken  || null,
    oauthTokenExpiry:   result.oauthTokenExpiry   || null,
    // Embedding fields
    embeddingEndpoint:  result.embeddingEndpoint   || null,
    embeddingModel:     result.embeddingModel      || null,
  };
}

// ── Long-lived port connection for streaming chat ──────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'omni-chat') return;

  chatPorts.add(port);
  port.onDisconnect.addListener(() => chatPorts.delete(port));

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'CHAT') {
      await handleChat(port, msg);
    }
    if (msg.type === 'CANCEL_STREAM') {
      const controller = activeStreams.get(port);
      if (controller) {
        controller.abort();
        activeStreams.delete(port);
      }
    }
    if (msg.type === 'TEST_CONNECTION') {
      await handleTestConnection(port);
    }
    if (msg.type === 'GET_TAB_COUNT') {
      port.postMessage({ type: 'TAB_COUNT', count: indexer.size() });
    }
    if (msg.type === 'GET_TIMELINE') {
      port.postMessage({ type: 'TIMELINE', entries: indexer.getTimeline() });
    }
    if (msg.type === 'GET_COHERENCE') {
      const coherence = indexer.getCoherenceScore();
      port.postMessage({ type: 'COHERENCE', ...coherence });
    }
    if (msg.type === 'SEARCH_TABS') {
      const query = msg.query || '';
      const domain = msg.domain || '';
      const results = [];
      if (query.length >= 2) {
        const scored = indexer.getAllScoredTabs(query);
        const qLower = query.toLowerCase();
        for (const tab of scored) {
          if (domain && !tab.url.includes(domain)) continue;
          const entry = indexer._index.get(tab.tabId);
          let snippet = '';
          if (entry?.content) {
            const cLower = entry.content.toLowerCase();
            const pos = cLower.indexOf(qLower);
            if (pos !== -1) {
              const start = Math.max(0, pos - 40);
              const end = Math.min(entry.content.length, pos + query.length + 80);
              snippet = (start > 0 ? '\u2026' : '') + entry.content.slice(start, end) + (end < entry.content.length ? '\u2026' : '');
            } else {
              snippet = entry.content.slice(0, 120) + (entry.content.length > 120 ? '\u2026' : '');
            }
          }
          results.push({ tabId: tab.tabId, title: tab.title, url: tab.url, score: tab.score, snippet });
        }
      }
      const domains = [...new Set([...indexer._index.values()].map(e => { try { return new URL(e.url).hostname; } catch (err) { errorLogger.log('background:searchTabs:parseHostname', err); return ''; } }).filter(Boolean))].sort();
      port.postMessage({ type: 'SEARCH_TABS_RESULT', results: results.slice(0, 20), domains });
    }
    if (msg.type === 'PING') {
      port.postMessage({ type: 'PONG' });
    }
    if (msg.type === 'GET_LAST_INDEXED') {
      port.postMessage({ type: 'LAST_INDEXED', timestamp: lastIndexedAt });
    }
  });
});

/**
 * Broadcast the current indexed tab count and total character count
 * to all connected sidepanel ports and persist the char count to storage.
 * Called after any index mutation (add/remove/reindex).
 */
function broadcastTabCount() {
  const count = indexer.size();
  let totalChars = 0;
  for (const entry of indexer._index.values()) {
    totalChars += (entry.content || '').length;
  }
  chrome.storage.local.set({ '_oc_indexed_chars': totalChars });
  for (const p of chatPorts) {
    try { p.postMessage({ type: 'TAB_COUNT', count }); } catch (err) { errorLogger.log('background:broadcastTabCount', err); }
  }
}

// ── One-shot message handler ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TAB_CONTENT') {
    const tabId = sender.tab?.id;
    if (tabId && msg.content) {
      indexer.upsert(tabId, { title: msg.title, url: msg.url, content: msg.content });
      schedulePersist(tabId);
      broadcastTabCount();
    }
    return false;
  }

  if (msg.type === 'GET_SETTINGS') {
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.type === 'REINDEX_ALL') {
    reindexAllTabs(true).then(() => { markIndexed(); sendResponse({ ok: true }); });
    return true;
  }

  if (msg.type === 'GET_INDEX_SIZE') {
    sendResponse({ count: indexer.size() });
    return false;
  }

  if (msg.type === 'GET_HISTORY') {
    handleGetHistory(sendResponse);
    return true;
  }

  if (msg.type === 'DELETE_HISTORY_ITEM') {
    handleDeleteHistoryItem(msg.id, sendResponse);
    return true;
  }

  if (msg.type === 'CLEAR_HISTORY') {
    handleClearHistory(sendResponse);
    return true;
  }

  if (msg.type === 'GET_HISTORY_SIZE') {
    handleGetHistorySize(sendResponse);
    return true;
  }

  if (msg.type === 'GET_LAST_INDEXED') {
    sendResponse({ timestamp: lastIndexedAt });
    return false;
  }

  if (msg.type === 'GET_TAB_GROUPS') {
    handleGetTabGroups(sendResponse);
    return true;
  }

  if (msg.type === 'OPEN_PAYMENT_PAGE') {
    openPaymentPage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'GET_DAILY_USAGE') {
    getDailyUsage().then(data => {
      data.cost = getCostEstimate(data.providers);
      sendResponse(data);
    }).catch(() => sendResponse({ input: 0, output: 0, queries: 0, providers: {}, cost: { total: 0, breakdown: [] } }));
    return true;
  }

  if (msg.type === 'GET_WEEKLY_USAGE') {
    getWeeklyUsage().then(data => {
      data.cost = getCostEstimate(data.providers);
      sendResponse(data);
    }).catch(() => sendResponse({ input: 0, output: 0, queries: 0, providers: {}, cost: { total: 0, breakdown: [] } }));
    return true;
  }

  if (msg.type === 'RESET_USAGE') {
    resetUsage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  // ── Exclusion & pinning handlers ───────────────────────────────────────────

  if (msg.type === 'GET_EXCLUSION_LIST') {
    getExcludedDomains().then(domains => sendResponse({ domains }));
    return true;
  }

  if (msg.type === 'SET_EXCLUSION_LIST') {
    chrome.storage.sync.set({ excludedDomains: msg.domains || [] })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_PINNED_LIST') {
    getPinnedDomains().then(domains => sendResponse({ domains }));
    return true;
  }

  if (msg.type === 'SET_PINNED_LIST') {
    chrome.storage.sync.set({ pinnedDomains: msg.domains || [] })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'EXCLUDE_DOMAIN') {
    getExcludedDomains().then(domains => {
      if (!domains.includes(msg.domain)) domains.push(msg.domain);
      chrome.storage.sync.set({ excludedDomains: domains }).then(() => {
        for (const [tabId, entry] of indexer._index) {
          if (isHostnameMatched(entry.url, [msg.domain])) {
            indexer.remove(tabId);
            tabLastUrl.delete(tabId);
          }
        }
        schedulePersist(null);
        broadcastTabCount();
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (msg.type === 'UNEXCLUDE_DOMAIN') {
    getExcludedDomains().then(domains => {
      const updated = domains.filter(d => d !== msg.domain);
      chrome.storage.sync.set({ excludedDomains: updated }).then(() => {
        reindexAllTabs(true).then(() => {
          markIndexed();
          sendResponse({ ok: true });
        });
      });
    });
    return true;
  }

  if (msg.type === 'PIN_DOMAIN') {
    getPinnedDomains().then(domains => {
      if (!domains.includes(msg.domain)) domains.push(msg.domain);
      chrome.storage.sync.set({ pinnedDomains: domains })
        .then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === 'UNPIN_DOMAIN') {
    getPinnedDomains().then(domains => {
      const updated = domains.filter(d => d !== msg.domain);
      chrome.storage.sync.set({ pinnedDomains: updated })
        .then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  // ── OAuth handlers ──────────────────────────────────────────────────────────

  if (msg.type === 'OAUTH_START') {
    handleOAuthStart(msg.provider, sendResponse);
    return true;
  }

  if (msg.type === 'OAUTH_DISCONNECT') {
    handleOAuthDisconnect(sendResponse);
    return true;
  }
});

// ── OAuth flow ─────────────────────────────────────────────────────────────────

/**
 * Initiate an OAuth authorization flow for the given provider.
 * Currently supports 'openai' using PKCE (RFC 7636). Exchanges the
 * authorization code for an access token and persists credentials to
 * chrome.storage.local. Sends the result back via sendResponse.
 * @param {string} provider  Provider identifier (e.g. 'openai').
 * @param {function({ok: boolean, accessToken?: string, error?: string}): void} sendResponse
 *   Chrome message response callback.
 * @returns {Promise<void>}
 */
async function handleOAuthStart(provider, sendResponse) {
  try {
    const redirectUri = chrome.identity.getRedirectURL('oauth-callback');

    if (provider === 'openai') {
      // Generate PKCE code verifier + challenge
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      const authUrl = new URL('https://auth.openai.com/authorize');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', 'omni-context-extension');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', 'openid profile email');
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl.toString(),
        interactive: true,
      });

      if (!responseUrl) {
        sendResponse({ ok: false, error: 'OAuth flow cancelled.' });
        return;
      }

      const url = new URL(responseUrl);
      const code = url.searchParams.get('code');
      if (!code) {
        sendResponse({ ok: false, error: 'No authorization code received.' });
        return;
      }

      // Exchange code for token
      const tokenResponse = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'omni-context-extension',
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      if (!tokenResponse.ok) {
        const body = await tokenResponse.text();
        let detail = `HTTP ${tokenResponse.status}`;
        try { detail = JSON.parse(body).error_description || JSON.parse(body).error || detail; } catch (err) { errorLogger.log('background:oauth:parseError', err); }
        sendResponse({ ok: false, error: `Token exchange failed: ${detail}` });
        return;
      }

      const tokenData = await tokenResponse.json();

      await chrome.storage.local.set({
        oauthProvider: 'openai',
        oauthAccessToken: tokenData.access_token,
        oauthRefreshToken: tokenData.refresh_token || null,
        oauthTokenExpiry: Date.now() + (tokenData.expires_in || 3600) * 1000,
      });

      sendResponse({ ok: true, accessToken: tokenData.access_token });
    } else {
      sendResponse({ ok: false, error: `OAuth not supported for provider: ${provider}` });
    }
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * Remove all OAuth tokens from chrome.storage.local, effectively logging out
 * the user from any provider-based OAuth session.
 * @param {function({ok: boolean}): void} sendResponse  Chrome message response callback.
 */
function handleOAuthDisconnect(sendResponse) {
  chrome.storage.local.remove([
    'oauthProvider', 'oauthAccessToken', 'oauthRefreshToken', 'oauthTokenExpiry'
  ]).then(() => {
    sendResponse({ ok: true });
  });
}

/**
 * Generate a cryptographically random PKCE code verifier (RFC 7636).
 * Produces a 43-character base64url-encoded string from 32 random bytes.
 * @returns {string} Base64url-encoded code verifier suitable for OAuth PKCE flow.
 */
function generateCodeVerifier() {
  const buffer = new Uint8Array(32);
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Derive a PKCE code challenge from a code verifier using SHA-256 (S256 method).
 * The challenge is sent to the authorization server; the verifier is sent during
 * token exchange to prove possession without exposing the verifier in the URL.
 * @param {string} verifier  The code verifier string generated by generateCodeVerifier().
 * @returns {Promise<string>} Base64url-encoded SHA-256 hash of the verifier.
 */
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── Chat handler ───────────────────────────────────────────────────────────────

/**
 * Handle an incoming CHAT message from the sidepanel port.
 * Orchestrates the full chat flow: validates auth/settings, builds context from
 * relevant indexed tabs, annotates with tab group info, streams the AI response
 * chunk-by-chunk back to the port, and saves the completed exchange to history.
 * Supports cancellation via AbortController and enforces a 60s timeout.
 * @param {chrome.runtime.Port} port  Long-lived message port to the sidepanel UI.
 * @param {import('./types/messages').PortMsg_Chat} msg
 *   Chat request payload containing conversation history, the active tab to exclude from context, and research mode flag.
 * @returns {Promise<void>}
 */
async function handleChat(port, msg) {
  const { messages, activeTabId, isResearch } = msg;

  const settings = await getSettings();

  // Check auth: either API key or valid OAuth token
  const hasOAuth = settings.oauthProvider && settings.oauthAccessToken &&
    (!settings.oauthTokenExpiry || settings.oauthTokenExpiry > Date.now());
  const hasKey = settings.provider && settings.apiKey;

  if (!hasKey && !hasOAuth) {
    port.postMessage({
      type: 'ERROR',
      error: 'No API key configured. Click the Settings button to add your API key.'
    });
    return;
  }

  if (!FeatureGate.isProviderAllowed(settings.provider)) {
    port.postMessage({
      type: 'ERROR',
      error: 'This AI provider requires Omni-Context Pro. Upgrade in Settings to unlock all 10 providers.'
    });
    return;
  }

  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  const query = lastUserMessage?.content || '';

  const pinnedDomains = await getPinnedDomains();
  const pinnedTabIds = new Set();
  if (pinnedDomains.length > 0) {
    for (const [tabId, entry] of indexer._index) {
      if (isHostnameMatched(entry.url, pinnedDomains)) pinnedTabIds.add(tabId);
    }
  }

  let queryEmbedding = null;
  if (FeatureGate.canUseSemanticSearch()) {
    const semanticResult = await chrome.storage.sync.get('semanticSearchEnabled');
    if (semanticResult.semanticSearchEnabled) {
      const embeddingConfig = getEmbeddingConfig(settings);
      if (embeddingConfig) {
        queryEmbedding = await generateEmbedding(query, embeddingConfig);
      }
    }
  }

  const contextString = indexer.buildContextString(query, activeTabId, pinnedTabIds, queryEmbedding);
  const sources = indexer.getSourceAttribution(query, activeTabId, pinnedTabIds);
  const allTabs = indexer.getAllScoredTabs(query, activeTabId);

  // Send all tab scores so UI can show relevance panel
  port.postMessage({ type: 'ALL_TAB_SCORES', tabs: allTabs });

  // Send relevant sources for the source map
  if (sources.length > 0) {
    port.postMessage({ type: 'SOURCES', sources });
  }

  // Mark referenced tabs and send timeline data
  const referencedIds = sources.map(s => s.tabId);
  if (referencedIds.length > 0) indexer.markReferenced(referencedIds);
  port.postMessage({ type: 'TIMELINE', entries: indexer.getTimeline() });

  // Smart context window management: trim messages to fit within model budget
  const modelLimit = getModelContextLimit(settings.model);
  const contextTokens = estimateTokens(contextString || '');
  const systemOverhead = 800;
  const availableForMessages = modelLimit - contextTokens - systemOverhead - 4096;
  const trimmedMessages = trimMessagesToFit(messages, availableForMessages, query);

  const usedMessageTokens = estimateTokens(trimmedMessages.map(m => m.content).join('\n'));
  const usedTotal = contextTokens + systemOverhead + usedMessageTokens;
  port.postMessage({
    type: 'TOKEN_BUDGET',
    used: usedTotal,
    max: modelLimit,
    model: settings.model || 'unknown'
  });

  // Annotate context with tab group info so AI can answer group-specific questions
  let annotatedContext = contextString;
  try {
    const [groups, chromeTabs] = await Promise.all([
      chrome.tabGroups.query({}),
      chrome.tabs.query({})
    ]);
    const namedGroups = groups.filter(g => g.title);
    if (namedGroups.length > 0) {
      const groupLines = namedGroups.map(g => {
        const gTabs = chromeTabs.filter(t => t.groupId === g.id);
        const titles = gTabs.map(t => t.title).filter(Boolean).join(', ');
        return `  "${g.title}" (${g.color || 'ungrouped'}): ${titles || '(no tabs)'}`;
      });
      const groupNote = `\n\n=== TAB GROUPS ===\nThe user's tabs are organized in these Chrome groups:\n${groupLines.join('\n')}\n=== END TAB GROUPS ===`;
      annotatedContext = (contextString || '') + groupNote;
    }
    // Send group data to sidepanel for display
    port.postMessage({ type: 'TAB_GROUPS', groups: namedGroups.map(g => ({
      id: g.id, title: g.title, color: g.color,
      tabs: chromeTabs.filter(t => t.groupId === g.id).map(t => ({ id: t.id, title: t.title }))
    }))});
  } catch (err) { errorLogger.log('background:handleChat:tabGroups', err); }

  // Build custom prompt config (Pro-only)
  let customPrompt = null;
  try {
    const isPro = FeatureGate.isPro;
    if (isPro) {
      const cpResult = await chrome.storage.sync.get(['customPromptText', 'customPromptMode']);
      if (cpResult.customPromptText) {
        const tabCount = indexer.size();
        customPrompt = {
          text: cpResult.customPromptText,
          mode: cpResult.customPromptMode || 'suffix',
          query,
          tabCount,
          tabContent: annotatedContext || ''
        };
      }
    }
  } catch (err) { errorLogger.log('background:handleChat:customPrompt', err); }

  let timedOut = false;
  const streamController = new AbortController();
  activeStreams.set(port, streamController);
  try {
    const provider = createProvider(settings);
    port.postMessage({ type: 'START' });

    let assembledResponse = '';

    const timeoutId = setTimeout(() => {
      timedOut = true;
      streamController.abort();
      port.postMessage({ type: 'ERROR', error: 'Request timed out. Try fewer tabs or a smaller context.' });
    }, 60000);

    await provider.streamChat(
      trimmedMessages,
      annotatedContext,
      isResearch || false,
      (chunk) => {
        if (timedOut) return;
        assembledResponse += chunk;
        port.postMessage({ type: 'CHUNK', text: chunk });
      },
      { signal: streamController.signal, customPrompt }
    );

    clearTimeout(timeoutId);
    if (timedOut) return;

    const fullInput = trimmedMessages.map(m => m.content).join('\n') + '\n' + annotatedContext;
    let tokenInfo = null;
    try {
      tokenInfo = await trackUsage(
        settings.provider || 'unknown',
        settings.model || 'unknown',
        fullInput,
        assembledResponse
      );
    } catch (err) { errorLogger.log('background:handleChat:trackUsage', err); }

    // Save to history
    const coherenceInfo = indexer.getCoherenceScore();
    const session = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      messages: [
        ...messages,
        { role: 'assistant', content: assembledResponse }
      ],
      tabs: sources.map(s => ({ tabId: s.tabId, title: s.title, url: s.url, score: s.score })),
      model: settings.model || '',
      provider: settings.provider,
      coherenceScore: coherenceInfo.score,
      isResearch: isResearch || false
    };
    await saveHistorySession(session);

    port.postMessage({
      type: 'DONE',
      tokenInfo: tokenInfo || undefined
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      port.postMessage({ type: 'DONE' });
    } else {
      errorLogger.log('background:handleChat:streamError', err);
      port.postMessage({ type: 'ERROR', error: err.message });
    }
  } finally {
    activeStreams.delete(port);
  }
}

// ── Tab groups handler ─────────────────────────────────────────────────────────

/**
 * Query all Chrome tab groups and their member tabs, formatted for the UI.
 * Responds with an array of group objects containing id, title, color, and nested tabs.
 * Falls back to an empty array on error (e.g., if tabGroups API is unavailable).
 * @param {function({groups: Array<{id: number, title: string, color: string, tabs: Array<{id: number, title: string, url: string}>}>}): void} sendResponse
 *   Chrome message response callback.
 * @returns {Promise<void>}
 */
async function handleGetTabGroups(sendResponse) {
  try {
    const [groups, tabs] = await Promise.all([
      chrome.tabGroups.query({}),
      chrome.tabs.query({})
    ]);
    const result = groups.map(g => ({
      id: g.id,
      title: g.title || '',
      color: g.color || 'grey',
      tabs: tabs.filter(t => t.groupId === g.id).map(t => ({ id: t.id, title: t.title, url: t.url }))
    }));
    sendResponse({ groups: result });
  } catch (err) {
    errorLogger.log('background:handleGetTabGroups', err);
    sendResponse({ groups: [] });
  }
}

// ── Test connection handler ────────────────────────────────────────────────────

/**
 * Test the current provider connection by making a lightweight API call.
 * Validates that settings are configured and the API key/OAuth token is valid,
 * then relays the provider's test result back to the sidepanel port.
 * @param {chrome.runtime.Port} port  Long-lived message port to respond on.
 * @returns {Promise<void>}
 */
async function handleTestConnection(port) {
  const settings = await getSettings();
  const hasOAuth = settings.oauthProvider && settings.oauthAccessToken;
  if (!settings.provider || (!settings.apiKey && !hasOAuth)) {
    port.postMessage({ type: 'TEST_RESULT', ok: false, error: 'No API key configured.' });
    return;
  }
  try {
    const result = await testProvider(settings);
    port.postMessage({ type: 'TEST_RESULT', ...result });
  } catch (err) {
    port.postMessage({ type: 'TEST_RESULT', ok: false, error: err.message });
  }
}

// ── History persistence ────────────────────────────────────────────────────────

const MAX_HISTORY_SESSIONS = 200;

/**
 * Persist a completed chat session to the conversation history.
 * Stores the session under a unique key (`hist_<uuid>`) and maintains
 * an ordered ID list capped at MAX_HISTORY_SESSIONS. Excess sessions
 * are pruned from storage on each write.
 * @param {{id: string, timestamp: number, messages: Array, tabs: Array, model: string, provider: string, coherenceScore: number, isResearch: boolean}} session
 *   Completed chat session to persist.
 * @returns {Promise<void>}
 */
async function saveHistorySession(session) {
  try {
    const key = `hist_${session.id}`;
    const stored = await chrome.storage.local.get(['historyIds']);
    const ids = stored.historyIds || [];

    ids.unshift(session.id);

    // Trim excess sessions
    const removed = ids.splice(MAX_HISTORY_SESSIONS);

    const updates = { [key]: session, historyIds: ids };
    await chrome.storage.local.set(updates);

    // Remove trimmed sessions
    if (removed.length > 0) {
      await chrome.storage.local.remove(removed.map(id => `hist_${id}`));
    }
  } catch (err) {
    errorLogger.log('background:saveHistorySession', err);
  }
}

/**
 * Retrieve all stored chat history sessions in reverse-chronological order.
 * Loads the session ID list and batch-fetches all corresponding session objects
 * from chrome.storage.local. Responds with an empty array on error.
 * @param {function({sessions: Array, error?: string}): void} sendResponse
 *   Chrome message response callback.
 * @returns {Promise<void>}
 */
async function handleGetHistory(sendResponse) {
  try {
    const stored = await chrome.storage.local.get(['historyIds']);
    const ids = stored.historyIds || [];
    if (ids.length === 0) {
      sendResponse({ sessions: [] });
      return;
    }
    const data = await chrome.storage.local.get(ids.map(id => `hist_${id}`));
    const sessions = ids.map(id => data[`hist_${id}`]).filter(Boolean);
    sendResponse({ sessions });
  } catch (err) {
    sendResponse({ sessions: [], error: err.message });
  }
}

/**
 * Delete a single chat history session by its UUID.
 * Removes the session's storage key and filters its ID from the ordered list.
 * @param {string} id  Session UUID to delete.
 * @param {function({ok: boolean, error?: string}): void} sendResponse
 *   Chrome message response callback.
 * @returns {Promise<void>}
 */
async function handleDeleteHistoryItem(id, sendResponse) {
  try {
    const stored = await chrome.storage.local.get(['historyIds']);
    const ids = (stored.historyIds || []).filter(i => i !== id);
    await chrome.storage.local.set({ historyIds: ids });
    await chrome.storage.local.remove(`hist_${id}`);
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * Delete all chat history sessions from storage.
 * Removes all `hist_*` keys and resets the historyIds list to empty.
 * @param {function({ok: boolean, error?: string}): void} sendResponse
 *   Chrome message response callback.
 * @returns {Promise<void>}
 */
async function handleClearHistory(sendResponse) {
  try {
    const stored = await chrome.storage.local.get(['historyIds']);
    const ids = stored.historyIds || [];
    const keys = ids.map(id => `hist_${id}`);
    if (keys.length > 0) {
      await chrome.storage.local.remove(keys);
    }
    await chrome.storage.local.set({ historyIds: [] });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * Calculate the total storage size (in bytes) used by chat history.
 * Iterates all stored sessions and sums their JSON-serialized lengths.
 * @param {function({bytes: number, count: number, error?: string}): void} sendResponse
 *   Chrome message response callback.
 * @returns {Promise<void>}
 */
async function handleGetHistorySize(sendResponse) {
  try {
    const stored = await chrome.storage.local.get(['historyIds']);
    const ids = stored.historyIds || [];
    if (ids.length === 0) {
      sendResponse({ bytes: 0, count: 0 });
      return;
    }
    const data = await chrome.storage.local.get(ids.map(id => `hist_${id}`));
    let bytes = 0;
    for (const val of Object.values(data)) {
      bytes += JSON.stringify(val).length;
    }
    sendResponse({ bytes, count: ids.length });
  } catch (err) {
    sendResponse({ bytes: 0, count: 0, error: err.message });
  }
}

// ── Re-index all open tabs ─────────────────────────────────────────────────────

/**
 * Re-index all currently open Chrome tabs.
 * By default only re-extracts tabs whose URL has changed since last indexing.
 * Also prunes index entries for tabs that have been closed.
 * @param {boolean} [force=false]  If true, re-extract all tabs regardless of URL change.
 * @returns {Promise<void>}
 */
async function reindexAllTabs(force = false) {
  const tabs = await chrome.tabs.query({});
  const work = tabs
    .filter(t => {
      if (!t.url || t.url.startsWith('chrome://') || t.url.startsWith('chrome-extension://')) return false;
      if (force) return true;
      return tabLastUrl.get(t.id) !== t.url;
    })
    .map(t => extractAndIndex(t.id, t));
  await Promise.allSettled(work);

  const openIds = new Set(tabs.map(t => t.id));
  let pruned = 0;
  for (const tabId of [...indexer._index.keys()]) {
    if (!openIds.has(tabId)) {
      indexer.remove(tabId);
      tabLastUrl.delete(tabId);
      pruned++;
    }
  }
  if (pruned > 0) { await indexer.persist(); _dirtySet.clear(); }
  broadcastTabCount();
}

// ── Smart context window: message trimming ────────────────────────────────────

/**
 * Trim conversation messages to fit within the model's available token budget.
 * Uses a relevance-based strategy: always keeps the last 2 messages for
 * conversational continuity, then scores older messages by keyword overlap
 * with the current query and recency. Dropped messages are replaced with a
 * summary note indicating how many were trimmed.
 * @param {Array<{role: string, content: string}>} messages  Full conversation history.
 * @param {number} availableTokens  Token budget remaining after context and system prompt.
 * @param {string} query  Current user query (used to score older message relevance).
 * @returns {Array<{role: string, content: string}>} Trimmed messages in chronological order,
 *   possibly prefixed with a system note about trimmed messages.
 */
function trimMessagesToFit(messages, availableTokens, query) {
  if (availableTokens <= 0) return messages.slice(-2);

  const totalTokens = estimateTokens(messages.map(m => m.content).join('\n'));
  if (totalTokens <= availableTokens) return messages;

  // Always keep the last 2 messages for conversational continuity
  const mustKeep = messages.slice(-2);
  const candidates = messages.slice(0, -2);
  const mustKeepTokens = estimateTokens(mustKeep.map(m => m.content).join('\n'));
  let budget = availableTokens - mustKeepTokens;

  if (budget <= 0) return mustKeep;

  // Score older messages by relevance to current query
  const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const scored = candidates.map((m, idx) => {
    const words = m.content.toLowerCase().split(/\s+/);
    const overlap = words.filter(w => queryWords.has(w)).length;
    const recency = idx / candidates.length;
    return { msg: m, score: overlap * 2 + recency, tokens: estimateTokens(m.content), idx };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected = [];
  for (const item of scored) {
    if (budget - item.tokens < 0) continue;
    budget -= item.tokens;
    selected.push(item);
  }

  // Restore original chronological order using stored index (O(n log n) vs O(n² log n))
  selected.sort((a, b) => a.idx - b.idx);

  // If we dropped messages, prepend a summary marker
  const keptMessages = selected.map(s => s.msg);
  if (keptMessages.length < candidates.length && keptMessages.length > 0) {
    const droppedCount = candidates.length - keptMessages.length;
    const summaryNote = { role: 'system', content: `[${droppedCount} earlier messages trimmed for context window]` };
    return [summaryNote, ...keptMessages, ...mustKeep];
  }

  return [...keptMessages, ...mustKeep];
}
