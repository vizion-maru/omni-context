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
import { trackUsage, getDailyUsage, getWeeklyUsage, getCostEstimate, resetUsage } from './lib/token-tracker.js';

const indexer = new Indexer();
const chatPorts = new Set();

// Active stream AbortControllers per port (for cancel support)
const activeStreams = new WeakMap();

// Restore persisted index, init feature gates, then prune stale tabs
errorLogger.load().then(() => {
  indexer.restore()
    .then(async () => {
      await FeatureGate.init();
      const sizeBefore = indexer.size();
      await indexer.reconcile();
      if (indexer.size() < sizeBefore) { await indexer.persist(); _dirtySet.clear(); }
      broadcastTabCount();
    })
    .catch((err) => { errorLogger.log('background:startup', err); });
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
    } catch (_) {
      for (const id of dirty) _dirtySet.add(id);
    }
  }, 2000);
}

// ── Auto-reindex tracking ──────────────────────────────────────────────────────
let lastIndexedAt = Date.now();
/** @type {Map<number, string>} tabId → last-indexed URL */
const tabLastUrl = new Map();

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
  markIndexed();
  broadcastTabCount();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;
  setTimeout(async () => {
    await extractAndIndex(tab.id);
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
  } catch (_) {
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
  } catch (_err) {
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

// ── Settings helpers ───────────────────────────────────────────────────────────

/**
 * Retrieve extension settings (provider, API key, model, OAuth tokens) from chrome.storage.local.
 * @returns {Promise<{provider: string|null, apiKey: string|null, model: string|null, oauthProvider: string|null, oauthAccessToken: string|null, oauthRefreshToken: string|null, oauthTokenExpiry: number|null}>}
 */
async function getSettings() {
  const result = await chrome.storage.local.get([
    'provider', 'apiKey', 'model',
    'oauthProvider', 'oauthAccessToken', 'oauthRefreshToken', 'oauthTokenExpiry'
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
      const domains = [...new Set([...indexer._index.values()].map(e => { try { return new URL(e.url).hostname; } catch (_) { return ''; } }).filter(Boolean))].sort();
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
        sendResponse({ ok: false, error: `Token exchange failed: HTTP ${tokenResponse.status}` });
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
 * @param {{messages: Array<{role: string, content: string}>, activeTabId: number|null, isResearch: boolean}} msg
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

  const contextString = indexer.buildContextString(query, activeTabId);
  const sources = indexer.getSourceAttribution(query, activeTabId);
  const allTabs = indexer.getAllScoredTabs(query, activeTabId);

  // Send all tab scores so UI can show relevance panel
  port.postMessage({ type: 'ALL_TAB_SCORES', tabs: allTabs });

  // Send relevant sources for the source map
  if (sources.length > 0) {
    port.postMessage({ type: 'SOURCES', sources });
  }

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

  let timedOut = false;
  const streamController = new AbortController();
  activeStreams.set(port, streamController);
  try {
    const provider = createProvider(settings);
    port.postMessage({ type: 'START' });

    let assembledResponse = '';

    let timeoutId = setTimeout(() => {
      timedOut = true;
      port.postMessage({ type: 'ERROR', error: 'Request timed out. Try fewer tabs or a smaller context.' });
    }, 60000);

    await provider.streamChat(
      messages,
      annotatedContext,
      isResearch || false,
      (chunk) => {
        if (timedOut) return;
        assembledResponse += chunk;
        port.postMessage({ type: 'CHUNK', text: chunk });
      },
      { signal: streamController.signal }
    );

    clearTimeout(timeoutId);
    if (timedOut) return;

    const fullInput = messages.map(m => m.content).join('\n') + '\n' + annotatedContext;
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
      console.error('[Omni-Context BG] Chat error:', err);
      port.postMessage({ type: 'ERROR', error: err.message });
    }
  } finally {
    activeStreams.delete(port);
  }
}

// ── Tab groups handler ─────────────────────────────────────────────────────────

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
    console.error('[Omni-Context BG] Failed to save history:', err);
  }
}

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
