/**
 * Omni-Context sidepanel UI logic — v3.
 * Communicates with background via a long-lived port for streaming.
 */
import { escHtml } from './lib/utils.js';
import { errorLogger } from './lib/error-logger.js';
import { shouldShowOnboarding, runOnboarding } from './onboarding.js';

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

  // ── Markdown setup ──────────────────────────────────────────────────────────

  marked.use({
    gfm: true,
    breaks: false,
    renderer: {
      link({ href, title, text }) {
        const t = title ? ` title="${escHtml(title)}"` : '';
        return `<a href="${escHtml(href)}"${t} target="_blank" rel="noopener">${text}</a>`;
      },
      code({ text, lang }) {
        const language = lang && hljs.getLanguage(lang) ? lang : null;
        const highlighted = language
          ? hljs.highlight(text, { language }).value
          : hljs.highlightAuto(text).value;
        const cls = language ? ` language-${escHtml(language)}` : '';
        return `<pre><code class="hljs${cls}">${highlighted}</code></pre>`;
      }
    }
  });

  // ── DOM refs ────────────────────────────────────────────────────────────────

  const messagesEl     = document.getElementById('messages');
  const welcomeEl      = document.getElementById('welcome');
  const emptyIndexedEl = document.getElementById('empty-indexed');
  const noKeyBanner    = document.getElementById('no-key-banner');
  const statusDot      = document.getElementById('status-dot');
  const statusText     = document.getElementById('status-text');
  const coherencePill  = document.getElementById('coherence-pill');
  const contextBar     = document.getElementById('context-bar');
  const contextBarTextEl = document.getElementById('context-bar-text');
  const contentCountEl = document.getElementById('content-count');
  const inputEl        = document.getElementById('input');
  const sendBtn        = document.getElementById('send-btn');
  const stopBtn        = document.getElementById('stop-btn');
  const exportBtn      = document.getElementById('export-btn');
  const newChatBtn     = document.getElementById('new-chat-btn');
  const settingsBtn    = document.getElementById('settings-btn');
  const researchBtn    = document.getElementById('research-btn');
  const tabBtnChat     = document.getElementById('tab-btn-chat');
  const tabBtnHistory  = document.getElementById('tab-btn-history');
  const viewChat       = document.getElementById('view-chat');
  const viewHistory    = document.getElementById('view-history');
  const historyList    = document.getElementById('history-list');
  const historyEmpty   = document.getElementById('history-empty');
  const historySearch  = document.getElementById('history-search');
  const historyClearBtn = document.getElementById('history-clear-btn');
  const tierBadge      = document.getElementById('tier-badge');
  const upgradeBanner  = document.getElementById('upgrade-banner');
  const upgradeBannerBtn   = document.getElementById('upgrade-banner-btn');
  const upgradeBannerClose = document.getElementById('upgrade-banner-close');
  const tabSearchInput     = document.getElementById('tab-search-input');
  const tabSearchDomain    = document.getElementById('tab-search-domain');
  const tabSearchResults   = document.getElementById('tab-search-results');
  const srStreamStatus     = document.getElementById('sr-stream-status');
  const tokenBudgetEl      = document.getElementById('token-budget');
  const tokenBudgetFill    = document.getElementById('token-budget-fill');
  const tokenBudgetLabel   = document.getElementById('token-budget-label');
  const timelineSection    = document.getElementById('timeline-section');
  const timelineList       = document.getElementById('timeline-list');

  // ── State ───────────────────────────────────────────────────────────────────

  const messages = [];          // {role, content} conversation history
  let port = null;
  let isStreaming = false;
  let hasApiKey = false;
  let researchMode = false;
  let currentQuery = '';
  let isProUser = false;

  // Source chip map: title → {tabId, favicon, url} (for chip click navigation)
  const sourcesMap = new Map();

  // All tabs with scores (for context bar list)
  let latestAllTabs = [];

  // Tab groups from Chrome (id → {title, color, tabs[]})
  let tabGroups = [];

  // Excluded & pinned domain lists (from chrome.storage.sync)
  let excludedDomains = [];
  let pinnedDomains = [];

  // Current streaming state
  let currentAssistantEl = null;
  let currentAssistantText = '';
  let streamStartTime = 0;
  let streamTimerInterval = null;

  // Follow-up suggestions state
  let isFetchingSuggestions = false;
  let suggestionText = '';
  let suggestionContainerEl = null;

  // Compare mode state
  let compareMode = false;
  let compareFirstChip = null;

  // Focused tab for click-to-focus relevance bars (cleared after next query)
  let focusedTabId = null;

  // Heartbeat
  let pingsMissed = 0;
  let heartbeatTimer = null;

  // Stream timeout
  let chunkTimeoutTimer = null;

  // Indexed content tracking
  let indexedContentChars = 0;
  let indexedTabCount = 0;

  // Mermaid counter for unique IDs
  let mermaidRenderCount = 0;

  // Session persistence debounce
  let persistTimer = null;

  /**
   * Debounced persist of the current conversation state to chrome.storage.session.
   * Saves messages, current query, and research mode flag so the conversation
   * survives sidepanel close/reopen within the same browser session.
   * Uses a 200ms debounce to batch rapid sequential message updates.
   */
  function persistConversation() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      chrome.storage.session.set({
        omni_conversation: { messages, currentQuery, researchMode }
      }).catch(err => console.warn('[OC sidepanel:persistConversation]', err));
    }, 200);
  }

  /**
   * Restore a previously persisted conversation from chrome.storage.session.
   * Re-renders all user and assistant messages (including forgotten state),
   * restores research mode toggle, and re-attaches interactive elements
   * (source chip listeners, mermaid diagrams). No-op if no persisted data exists.
   * @returns {Promise<void>}
   */
  async function restoreConversation() {
    try {
      const result = await chrome.storage.session.get('omni_conversation');
      const data = result.omni_conversation;
      if (!data || !Array.isArray(data.messages) || data.messages.length === 0) return;

      messages.push(...data.messages);
      currentQuery = data.currentQuery || '';
      researchMode = data.researchMode || false;

      for (const m of messages) {
        if (m.role === 'user') {
          appendUserMessage(m.content);
          if (m.forgotten) {
            const lastMsg = messagesEl.querySelector('.msg.user:last-of-type');
            if (lastMsg) lastMsg.classList.add('forgotten');
          }
        } else if (m.role === 'assistant') {
          const el = createMessageEl('assistant', renderMarkdown(m.content));
          if (m.forgotten) el.classList.add('forgotten');
          messagesEl.appendChild(el);
          attachChipListeners(el.querySelector('.msg-text'));
          renderMermaidBlocks(el);
        }
      }

      if (exportBtn && messages.length > 0) exportBtn.style.display = '';
      if (researchMode) {
        researchBtn.classList.add('active');
        inputEl.placeholder = msg('PLACEHOLDER_RESEARCH');
      }
      scrollToBottom();
    } catch (err) {
      console.warn('[OC sidepanel:restoreConversation]', err);
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  /**
   * Entry point for the sidepanel UI. Applies i18n translations, checks
   * whether the first-run onboarding wizard should be shown, and either
   * launches onboarding or proceeds directly to initCore().
   * @returns {Promise<void>}
   */
  async function init() {
    localizeHtml();
    document.title = msg('APP_NAME');

    if (await shouldShowOnboarding()) {
      runOnboarding(() => { initCore(); });
      return;
    }
    initCore();
  }

  /**
   * Core initialization after onboarding is complete. Establishes the
   * background port connection, checks API key settings, restores session
   * state (conversation, tab counts, exclusion lists), and wires up all
   * UI event handlers (input, navigation, research mode, export, shortcuts).
   * @returns {Promise<void>}
   */
  async function initCore() {
    connectPort();
    await checkSettings();
    await loadIndexedContentSize();
    await loadPersistedTabCount();
    setupInput();
    setupNavTabs();
    setupResearchBtn();
    setupExportBtn();
    setupNewChatBtn();
    setupKeyboardShortcuts();
    startLastIndexedUpdater();
    loadTabGroups();
    initMermaid();
    await loadExclusionPinningState();
    await restoreConversation();
    await loadProStatus();
  }

  /**
   * Load the persisted tab index entry count from chrome.storage.local.
   * Used on startup to immediately show the correct tab count in the context
   * bar before the background service worker sends a fresh TAB_COUNT message.
   * Only updates UI if no live count has been received yet (indexedTabCount === 0).
   * @returns {Promise<void>}
   */
  async function loadPersistedTabCount() {
    try {
      const result = await chrome.storage.local.get('_tabIndex_v1');
      const stored = result['_tabIndex_v1'];
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        const count = Object.keys(stored).length;
        if (count > 0 && indexedTabCount === 0) {
          indexedTabCount = count;
          updateContextBar(indexedTabCount);
          updateEmptyIndexedState(indexedTabCount);
        }
      }
    } catch (err) { console.warn('[OC sidepanel:loadPersistedTabCount]', err); }
  }

  // ── Mermaid init ────────────────────────────────────────────────────────────

  /**
   * Initialize the Mermaid diagram rendering library with dark-theme styling.
   * Configures security level to 'strict' (no inline scripts in SVG output),
   * disables auto-start (diagrams are rendered on-demand via renderMermaidBlocks),
   * and sets color variables matching the extension's dark UI palette.
   * No-op if the mermaid global is not loaded (e.g., library failed to load).
   */
  function initMermaid() {
    if (typeof mermaid === 'undefined') return;
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        primaryColor: '#222536',
        primaryTextColor: '#e2e4f0',
        primaryBorderColor: '#2c2f45',
        lineColor: '#3B82F6',
        secondaryColor: '#1a1d27',
        tertiaryColor: '#0f1117',
        fontSize: '13px'
      },
      securityLevel: 'strict',
      flowchart: { curve: 'basis' }
    });
  }

  /**
   * Sanitize raw Mermaid diagram definition to prevent XSS injection.
   * Mermaid renders SVG from user/AI-provided text which could contain
   * malicious payloads. This strips:
   *  - <script> tags (inline JS execution)
   *  - on* event handler attributes (e.g. onclick, onerror)
   *  - javascript: protocol URIs (link/href hijacking)
   *  - data:text/html URIs (embedded HTML documents)
   *
   * @param {string} raw  Untrusted Mermaid graph definition text from AI response.
   * @returns {string} Sanitized definition safe for mermaid.render().
   */
  function sanitizeMermaidInput(raw) {
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+\s+on\w+\s*=[\s\S]*?>/gi, (match) => match.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''))
      .replace(/javascript\s*:/gi, '')
      .replace(/data\s*:\s*text\/html/gi, '');
  }

  /**
   * Find and render all Mermaid diagram code blocks within a message container.
   * Replaces ```mermaid fenced code blocks with interactive SVG diagrams.
   * Each rendered diagram is wrapped in a collapsible container with a toggle button.
   * Diagram nodes become clickable — clicking sends the node's label as a new query.
   * Sanitizes diagram definitions before rendering to prevent XSS injection.
   * Gracefully falls back to showing raw code if mermaid.render() fails.
   * @param {HTMLElement} container  The message element containing potential mermaid code blocks.
   * @returns {Promise<void>}
   */
  async function renderMermaidBlocks(container) {
    if (typeof mermaid === 'undefined') return;

    const blocks = container.querySelectorAll('pre code.language-mermaid');
    if (!blocks.length) return;

    for (const block of blocks) {
      const pre = block.parentElement;
      if (!pre || pre.tagName !== 'PRE') continue;

      const graphDef = sanitizeMermaidInput(block.textContent);
      const id = `mermaid-${mermaidRenderCount++}`;

      try {
        const { svg } = await mermaid.render(id, graphDef);
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-wrapper';

        const svgContainer = document.createElement('div');
        svgContainer.className = 'mermaid-svg';
        svgContainer.innerHTML = svg;

        // Make nodes clickable
        svgContainer.querySelectorAll('g.node, g.cluster, g.edgeLabel, text, rect, circle, ellipse, polygon, path').forEach(node => {
          node.style.cursor = 'pointer';
          node.addEventListener('click', (e) => {
            e.stopPropagation();
            const label = getNodeLabel(node);
            if (label && label.length > 2 && label.length < 100) {
              inputEl.value = msg('MERMAID_CLICK_PROMPT', [label]);
              autoResizeInput();
              send();
            }
          });
        });

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'mermaid-toggle';
        toggleBtn.textContent = '\uD83D\uDCCA ' + msg('DIAGRAM_LABEL');
        toggleBtn.addEventListener('click', () => {
          wrapper.classList.toggle('collapsed');
        });

        wrapper.appendChild(toggleBtn);
        wrapper.appendChild(svgContainer);
        pre.replaceWith(wrapper);
      } catch (err) {
        console.warn('[OC sidepanel:renderMermaidBlocks]', err);
        block.parentElement?.classList.add('mermaid-fallback');
      }
    }
  }

  /**
   * Extract the human-readable text label from an SVG node in a Mermaid diagram.
   * Used to determine what query to send when a user clicks a diagram node.
   * Traverses the SVG structure checking: direct text elements, child text/tspan
   * elements, and finally concatenates all nested text nodes for group labels.
   * @param {SVGElement} node  The SVG element (g.node, text, rect, etc.) that was clicked.
   * @returns {string|null} The extracted label text (trimmed), or null if no text found.
   */
  function getNodeLabel(node) {
    if (node.tagName === 'text') {
      return node.textContent?.trim() || null;
    }
    const textEl = node.querySelector('text, tspan');
    if (textEl) return textEl.textContent?.trim() || null;

    // For edge labels or group labels — concatenate all text fragments
    const labels = node.querySelectorAll('text, tspan');
    if (labels.length > 0) {
      const combined = Array.from(labels).map(l => l.textContent?.trim()).filter(Boolean).join(' ');
      return combined || null;
    }
    return null;
  }

  // ── Port management + heartbeat ─────────────────────────────────────────────

  /**
   * Establish a long-lived port connection to the background service worker.
   * Handles automatic reconnection on disconnect (1s delay) and starts a
   * heartbeat interval (PING every 20s). If 3 consecutive PONGs are missed,
   * the port is considered dead and reconnection is triggered.
   * On successful connect, requests initial TAB_COUNT and COHERENCE data.
   */
  function connectPort() {
    if (port) {
      try { port.disconnect(); } catch (err) { console.warn('[OC sidepanel:connectPort:disconnect]', err); }
    }

    port = chrome.runtime.connect({ name: 'omni-chat' });
    port.onMessage.addListener(handlePortMessage);

    port.onDisconnect.addListener(() => {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      setTimeout(() => {
        if (!port || port.sender === undefined) connectPort();
      }, 1000);
    });

    // Start heartbeat: PING every 20s, reconnect after 3 missed PONGs
    pingsMissed = 0;
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!port) return;
      pingsMissed++;
      if (pingsMissed > 3) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        connectPort();
        return;
      }
      try { port.postMessage({ type: 'PING' }); } catch (err) { console.warn('[OC sidepanel:heartbeat]', err); }
    }, 20000);

    // Request initial data
    requestTabCount();
    requestCoherence();
  }

  /** Request the current indexed tab count from the background service worker. */
  function requestTabCount() {
    try { port.postMessage({ type: 'GET_TAB_COUNT' }); } catch (err) { console.warn('[OC sidepanel:requestTabCount]', err); }
    try { port.postMessage({ type: 'GET_TIMELINE' }); } catch (err) { errorLogger.log('sidepanel:requestTimeline', err); }
  }

  /** Request the coherence score (topic overlap) from the background service worker. */
  function requestCoherence() {
    try { port.postMessage({ type: 'GET_COHERENCE' }); } catch (err) { console.warn('[OC sidepanel:requestCoherence]', err); }
  }

  // ── Settings check ──────────────────────────────────────────────────────────

  /**
   * Check if the user has configured a provider and API key.
   * Updates the status indicator and shows/hides the "no API key" banner.
   * Queries the background service worker for current settings via message.
   * @returns {Promise<void>}
   */
  async function checkSettings() {
    const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    hasApiKey = !!(settings?.provider && settings?.apiKey);
    updateStatus(hasApiKey ? 'ok' : 'none');
    noKeyBanner.style.display = hasApiKey ? 'none' : 'block';
  }

  // ── Status indicator ────────────────────────────────────────────────────────

  /**
   * Update the connection status dot and label text in the sidepanel header.
   * @param {'ok'|'loading'|'error'|'none'} state  Current connection/readiness state.
   *   'ok' = green dot, ready; 'loading' = pulsing, thinking; 'error' = red dot;
   *   'none' (or any other value) = grey dot, no API key configured.
   */
  function updateStatus(state) {
    statusDot.className = 'status-dot';
    switch (state) {
      case 'ok':
        statusDot.classList.add('ok');
        statusText.textContent = msg('STATUS_READY');
        break;
      case 'loading':
        statusDot.classList.add('loading');
        statusText.textContent = msg('STATUS_THINKING');
        break;
      case 'error':
        statusDot.classList.add('error');
        statusText.textContent = msg('STATUS_ERROR');
        break;
      default:
        statusText.textContent = msg('STATUS_NO_KEY');
    }
  }

  // ── Port message handler ────────────────────────────────────────────────────

  /**
   * Route incoming messages from the background service worker port.
   * Handles: PONG (heartbeat), TAB_COUNT, COHERENCE, TAB_GROUPS,
   * ALL_TAB_SCORES, SOURCES, START/CHUNK/DONE (streaming), and ERROR.
   * @param {import('./types/messages').PortMessageToSidepanel} msg  Message object from the background port.
   */
  function handlePortMessage(msg) {
    switch (msg.type) {

      case 'PONG':
        pingsMissed = 0;
        break;

      case 'TAB_COUNT':
        indexedTabCount = msg.count || 0;
        updateContextBar(indexedTabCount);
        updateEmptyIndexedState(indexedTabCount);
        break;

      case 'COHERENCE':
        updateCoherencePill(msg.score, msg.topic, msg.outliers);
        break;

      case 'TAB_GROUPS':
        tabGroups = msg.groups || [];
        updateContextTabList(latestAllTabs);
        break;

      case 'ALL_TAB_SCORES':
        latestAllTabs = msg.tabs || [];
        showTabRelevance(latestAllTabs);
        updateContextTabList(latestAllTabs);
        break;

      case 'TOKEN_BUDGET':
        updateTokenBudget(msg.used, msg.max, msg.model);
        break;

      case 'TIMELINE':
        renderTimeline(msg.entries || []);
        break;

      case 'SEARCH_TABS_RESULT':
        renderTabSearchResults(msg.results || [], msg.domains || []);
        break;

      case 'SOURCES':
        // Build title→{tabId, favicon, url} map for chip click navigation
        const sources = msg.sources || [];
        sources.forEach(s => {
          if (s.title && s.tabId) sourcesMap.set(s.title, { tabId: s.tabId, favicon: s.favicon || null, url: s.url || null });
        });
        // Fetch favicon URLs from chrome.tabs for sources missing them
        sources.forEach(s => {
          if (s.title && s.tabId && !s.favicon) {
            chrome.tabs.get(s.tabId, (tab) => {
              if (chrome.runtime.lastError) return;
              if (tab?.favIconUrl) {
                const info = sourcesMap.get(s.title);
                if (info) {
                  info.favicon = tab.favIconUrl;
                  updateChipFavicons();
                }
              }
            });
          }
        });
        // Update existing source chips with favicons
        updateChipFavicons();
        break;

      case 'START':
        if (isFetchingSuggestions) {
          resetChunkTimeout();
          break;
        }
        updateStatus('loading');
        resetChunkTimeout();
        break;

      case 'CHUNK':
        clearTimeout(chunkTimeoutTimer);
        resetChunkTimeout();
        if (isFetchingSuggestions) {
          suggestionText += msg.text;
        } else {
          appendChunk(msg.text);
        }
        break;

      case 'DONE':
        clearTimeout(chunkTimeoutTimer);
        if (isFetchingSuggestions) {
          finalizeSuggestions();
        } else {
          finishStreaming(msg.tokenInfo);
        }
        break;

      case 'QUOTA_WARNING':
        showQuotaWarning();
        break;

      case 'ERROR':
        clearTimeout(chunkTimeoutTimer);
        if (!isFetchingSuggestions) {
          showError(msg.error);
          finishStreaming();
        }
        // Silently ignore suggestion errors
        if (isFetchingSuggestions) {
          isFetchingSuggestions = false;
          suggestionText = '';
          if (suggestionContainerEl) {
            suggestionContainerEl.remove();
            suggestionContainerEl = null;
          }
        }
        break;
    }
  }

  // ── Stream timeout ──────────────────────────────────────────────────────────

  /**
   * Reset the stream inactivity timeout (60 seconds).
   * Called on each received chunk to keep the timeout rolling. If no chunk
   * arrives within 60s, the timeout fires and:
   *  - For active AI streams: shows a timeout error and finishes streaming.
   *  - For follow-up suggestion fetches: silently aborts and removes the
   *    suggestion container from the DOM.
   * Safe to call multiple times — each call clears the previous timer.
   */
  function resetChunkTimeout() {
    clearTimeout(chunkTimeoutTimer);
    chunkTimeoutTimer = setTimeout(() => {
      if (isStreaming || isFetchingSuggestions) {
        if (!isFetchingSuggestions) {
          showError(msg('ERROR_TIMEOUT'));
          finishStreaming();
        }
        isFetchingSuggestions = false;
        suggestionText = '';
        if (suggestionContainerEl) {
          suggestionContainerEl.remove();
          suggestionContainerEl = null;
        }
      }
    }, 60000);
  }

  // ── Coherence pill ──────────────────────────────────────────────────────────

  /**
   * Update the coherence pill badge in the UI header.
   * Displays the dominant topic keyword and coherence percentage.
   * Hides the pill entirely when no coherence data is available.
   * @param {number|null} score  Coherence percentage (0–100), or null to hide.
   * @param {string} topic  Comma-separated top keywords detected across tabs.
   * @param {number[]} outliers  Tab IDs that are thematically distant from the group.
   */
  function updateCoherencePill(score, topic, outliers) {
    if (score === null || score === undefined) {
      coherencePill.classList.add('hidden');
      return;
    }
    const topicLabel = topic ? topic.split(',')[0].trim() : 'Topics';
    coherencePill.textContent = `\uD83C\uDFAF ${topicLabel} \u2022 ${score}%`;
    const outlierInfo = (outliers && outliers.length > 0)
      ? msg('OUTLIER_INFO', [String(outliers.length), outliers.length > 1 ? 's' : ''])
      : '';
    coherencePill.title = msg('COHERENCE_TITLE', [String(score)]) + outlierInfo;
    coherencePill.classList.remove('hidden');
  }

  // ── Context bar (expandable with tab list) ──────────────────────────────────

  /**
   * Show or hide the context bar based on indexed tab count.
   * When tabs are indexed (count > 0), displays "Using N tabs" text and
   * triggers the content size label update. Hides the bar when count is 0.
   * @param {number} count  Number of tabs currently indexed by the service worker.
   */
  function updateContextBar(count) {
    if (count > 0) {
      if (contextBarTextEl) contextBarTextEl.textContent = msg('CONTEXT_BAR_USING', [String(count)]);
      contextBar.classList.remove('hidden');
      updateContentCountLabel();
    } else {
      contextBar.classList.add('hidden');
    }
  }

  /**
   * Update the content count label showing total indexed content size in kB.
   * Reads from the module-level indexedContentChars variable and formats
   * it as "X.Xk chars". Clears the label if no content is indexed.
   */
  function updateContentCountLabel() {
    if (!contentCountEl) return;
    if (indexedContentChars > 0) {
      const k = (indexedContentChars / 1000).toFixed(1);
      contentCountEl.textContent = msg('CONTENT_COUNT', [k]);
    } else {
      contentCountEl.textContent = '';
    }
  }

  /**
   * Toggle visibility of the welcome screen vs. empty-indexed prompt.
   * Shows appropriate UI state based on whether messages exist and tabs are indexed:
   *  - Has messages → hide both (conversation is active)
   *  - No messages + tabs indexed → show welcome (ready to chat)
   *  - No messages + no tabs → show empty-indexed prompt (needs browsing)
   * @param {number} count  Number of tabs currently indexed.
   */
  function updateEmptyIndexedState(count) {
    if (!emptyIndexedEl || !welcomeEl) return;
    const hasMessages = messages.length > 0;
    if (hasMessages) {
      welcomeEl.classList.add('hidden');
      emptyIndexedEl.classList.add('hidden');
    } else if (count > 0) {
      welcomeEl.classList.remove('hidden');
      emptyIndexedEl.classList.add('hidden');
    } else {
      welcomeEl.classList.add('hidden');
      emptyIndexedEl.classList.remove('hidden');
    }
  }

  /**
   * Render the expandable context tab list in the context bar.
   * Builds two sections:
   *  1. Tab groups (if any exist) — labelled rows with colored dots, group names,
   *     tab counts, and a "Summarize" action button for each group.
   *  2. Individual tabs — listed with title and a color-coded relevance score badge
   *     (high ≥50%, mid ≥20%, low <20%).
   * Clears and fully rebuilds the list on each call.
   * @param {Array<{tabId: number, title: string, url: string, score: number}>} allTabs
   *   All indexed tabs with their current relevance scores (0–1), sorted by score descending.
   */
  function updateContextTabList(allTabs) {
    contextTabList.innerHTML = '';

    // Show tab groups as labelled sections if any exist
    if (tabGroups.length > 0) {
      const groupSection = document.createElement('div');
      groupSection.className = 'context-groups';
      groupSection.style.cssText = 'padding: 4px 0 6px; border-bottom: 1px solid rgba(44,47,69,0.5); margin-bottom: 4px;';

      const groupsLabel = document.createElement('div');
      groupsLabel.style.cssText = `font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--oc-text-muted); margin-bottom: 4px;`;
      groupsLabel.textContent = msg('TAB_GROUPS_LABEL');
      groupSection.appendChild(groupsLabel);

      tabGroups.forEach(g => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 0; cursor:pointer;';

        const dot = document.createElement('span');
        dot.style.cssText = `width:8px; height:8px; border-radius:50%; flex-shrink:0; background:${groupColorToHex(g.color)};`;

        const label = document.createElement('span');
        label.style.cssText = 'font-size:11px; color:var(--oc-text-dim); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        label.textContent = `${g.title} (${g.tabs.length})`;

        const askBtn = document.createElement('button');
        askBtn.style.cssText = `font-size:9px; padding:1px 5px; border-radius:3px; background:none; border:1px solid var(--oc-border); color:var(--oc-text-muted); cursor:pointer; flex-shrink:0;`;
        askBtn.textContent = msg('SUMMARIZE');
        askBtn.title = msg('ASK_ABOUT_GROUP_TITLE', [g.title]);
        askBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          inputEl.value = msg('SUMMARIZE_GROUP_PROMPT', [g.title]);
          autoResizeInput();
          inputEl.focus();
        });

        row.appendChild(dot);
        row.appendChild(label);
        row.appendChild(askBtn);
        groupSection.appendChild(row);
      });

      contextTabList.appendChild(groupSection);
    }

    // Then list individual tabs
    allTabs.forEach(tab => {
      const pct = Math.round(tab.score * 100);
      const item = document.createElement('div');
      item.className = 'context-tab-item';

      const title = document.createElement('span');
      title.className = 'context-tab-title';
      title.textContent = tab.title || tab.url;

      const score = document.createElement('span');
      const cls = pct >= 50 ? 'high' : pct >= 20 ? 'mid' : 'low';
      score.className = `context-tab-score ${cls}`;
      score.textContent = pct + '%';

      item.appendChild(title);
      item.appendChild(score);
      contextTabList.appendChild(item);
    });
  }

  // ── Activity Timeline ────────────────────────────────────────────────────────

  const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

  /**
   * Render the activity timeline showing recently active/referenced tabs.
   * Displays up to 12 entries sorted by most recent activity. Each entry
   * shows a freshness indicator (fresh <10min, stale >10min), the tab title,
   * and a relative timestamp. Hides the timeline section when no entries exist.
   * @param {Array<{tabId: number, title: string, url: string, firstIndexed: number, lastContentChange: number, lastReferenced: number}>} entries
   *   Timeline entries from the indexer, sorted by most recent activity descending.
   */
  function renderTimeline(entries) {
    if (!timelineSection || !timelineList) return;
    if (entries.length === 0) {
      timelineSection.classList.add('hidden');
      return;
    }

    timelineSection.classList.remove('hidden');
    timelineList.innerHTML = '';
    const now = Date.now();

    entries.slice(0, 12).forEach(entry => {
      const latestActivity = Math.max(entry.lastContentChange, entry.lastReferenced);
      const age = now - latestActivity;
      const isStale = age > STALE_THRESHOLD_MS;

      const row = document.createElement('div');
      row.className = 'timeline-item';

      const indicator = document.createElement('span');
      indicator.className = `timeline-indicator ${isStale ? 'stale' : 'fresh'}`;
      indicator.title = isStale
        ? msg('TIMELINE_STALE') || 'Stale (>10 min)'
        : msg('TIMELINE_FRESH') || 'Fresh';

      const label = document.createElement('span');
      label.className = 'timeline-label';
      label.textContent = entry.title || entry.url;

      const time = document.createElement('span');
      time.className = 'timeline-time';
      time.textContent = formatRelativeTime(latestActivity, now);

      row.appendChild(indicator);
      row.appendChild(label);
      row.appendChild(time);
      timelineList.appendChild(row);
    });
  }

  /**
   * Format a timestamp as a human-readable relative time string.
   * Returns abbreviated duration labels: 'just now', '5m', '2h', '3d'.
   * Uses the i18n message 'TIMELINE_JUST_NOW' for the < 1 minute case.
   * @param {number} ts  Unix timestamp in milliseconds to format.
   * @param {number} now  Current time in milliseconds (Date.now()) for computing the delta.
   * @returns {string} Abbreviated relative time string, or '' if ts is falsy.
   */
  function formatRelativeTime(ts, now) {
    if (!ts) return '';
    const diff = now - ts;
    if (diff < 60000) return msg('TIMELINE_JUST_NOW') || 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return `${Math.floor(diff / 86400000)}d`;
  }

  /**
   * Convert a Chrome tab group color name to its hex color value.
   * Falls back to grey (#5f6368) for unknown color names.
   * @param {string} color  Chrome tab group color name (e.g. 'blue', 'red', 'green').
   * @returns {string} CSS hex color string.
   */
  function groupColorToHex(color) {
    const map = {
      grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00',
      green: '#1e8e3e', pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#e8710a'
    };
    return map[color] || '#5f6368';
  }

  /**
   * Generate a consistent HSL hue value (0–359) from a URL's hostname.
   * Uses the DJB2 hash algorithm on the domain string to produce a
   * deterministic color — the same domain always gets the same hue,
   * giving visual consistency to domain-colored UI elements (relevance bars, chips).
   * @param {string} url  Full URL to derive the hue from. Falls back to raw string on parse failure.
   * @returns {number} HSL hue angle between 0 and 359 (inclusive).
   */
  function domainToHue(url) {
    let domain = '';
    try { domain = new URL(url).hostname; } catch (_) { domain = url || ''; }
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
      hash = ((hash << 5) - hash) + domain.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % 360;
  }

  // ── Tab content search ──────────────────────────────────────────────────────

  let tabSearchTimer = null;

  if (tabSearchInput) {
    tabSearchInput.addEventListener('input', () => {
      clearTimeout(tabSearchTimer);
      tabSearchTimer = setTimeout(() => fireTabSearch(), 200);
    });
  }
  if (tabSearchDomain) {
    tabSearchDomain.addEventListener('change', () => fireTabSearch());
  }

  /**
   * Trigger a tab content search via the background service worker.
   * Sends the current search query and optional domain filter through the port.
   * Requires at least 2 characters in the query; hides results if too short.
   */
  function fireTabSearch() {
    const query = tabSearchInput?.value.trim() || '';
    const domain = tabSearchDomain?.value || '';
    if (query.length < 2) {
      tabSearchResults?.classList.add('hidden');
      return;
    }
    try {
      port.postMessage({ type: 'SEARCH_TABS', query, domain });
    } catch (err) { errorLogger.log('sidepanel:searchTabs', err); }
  }

  /**
   * Render tab search results into the search results panel.
   * Updates the domain filter dropdown, displays result count, and creates
   * clickable result items with title, score badge, and highlighted snippet.
   * @param {Array<{tabId: number, title: string, url: string, score: number, snippet?: string}>} results
   *   Matched tabs sorted by relevance score descending.
   * @param {string[]} domains  Unique domains across all indexed tabs for the domain filter dropdown.
   */
  function renderTabSearchResults(results, domains) {
    if (!tabSearchResults) return;

    if (tabSearchDomain && domains.length > 0) {
      const current = tabSearchDomain.value;
      tabSearchDomain.innerHTML = `<option value="">${msg('TAB_SEARCH_ALL_DOMAINS')}</option>`;
      domains.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        tabSearchDomain.appendChild(opt);
      });
      if (current && domains.includes(current)) tabSearchDomain.value = current;
    }

    tabSearchResults.innerHTML = '';

    if (results.length === 0) {
      tabSearchResults.classList.remove('hidden');
      const empty = document.createElement('div');
      empty.className = 'tab-search-empty';
      empty.textContent = msg('TAB_SEARCH_NO_RESULTS');
      tabSearchResults.appendChild(empty);
      return;
    }

    const countEl = document.createElement('div');
    countEl.className = 'tab-search-count';
    countEl.textContent = msg('TAB_SEARCH_RESULT_COUNT', [String(results.length), results.length !== 1 ? 's' : '']);
    tabSearchResults.appendChild(countEl);

    const queryVal = (tabSearchInput?.value || '').trim().toLowerCase();

    results.forEach(r => {
      const item = document.createElement('div');
      item.className = 'tab-search-result';

      const titleRow = document.createElement('div');
      titleRow.className = 'tab-search-title';
      titleRow.textContent = r.title || r.url;
      titleRow.title = r.url;

      if (r.tabId) {
        titleRow.style.cursor = 'pointer';
        titleRow.addEventListener('click', () => {
          chrome.tabs.update(r.tabId, { active: true }).catch(() => {});
        });
      }

      const pct = Math.round((r.score || 0) * 100);
      if (pct > 0) {
        const scoreBadge = document.createElement('span');
        scoreBadge.className = 'tab-search-score';
        scoreBadge.textContent = pct + '%';
        titleRow.appendChild(scoreBadge);
      }

      item.appendChild(titleRow);

      if (r.snippet) {
        const snippetEl = document.createElement('div');
        snippetEl.className = 'tab-search-snippet';
        if (queryVal) {
          snippetEl.innerHTML = highlightSnippet(r.snippet, queryVal);
        } else {
          snippetEl.textContent = r.snippet;
        }
        item.appendChild(snippetEl);
      }

      tabSearchResults.appendChild(item);
    });

    tabSearchResults.classList.remove('hidden');
  }

  /**
   * Highlight matching query terms in a text snippet using <mark> tags.
   * Escapes HTML in the snippet first to prevent XSS, then wraps matches.
   * @param {string} snippet  Plain text snippet from tab content.
   * @param {string} query  Lowercase search query to highlight.
   * @returns {string} HTML string with matching portions wrapped in <mark> tags.
   */
  function highlightSnippet(snippet, query) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escHtml(snippet).replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  }

  // ── Tab relevance section (shown before each answer) ────────────────────────

  function showTabRelevance(allTabs) {
    const relevant   = allTabs.filter(t => t.score >= 0.05);
    const irrelevant = allTabs.filter(t => t.score < 0.05);

    if (allTabs.length > 0 && relevant.length === 0) {
      showNoMatchWarning(currentQuery);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'tab-relevance';

    const details = document.createElement('details');
    details.className = 'tab-relevance-details';
    details.open = relevant.length <= 4;

    const summary = document.createElement('summary');
    summary.innerHTML = `\uD83D\uDCD1 ${msg('USED_TABS_LABEL')} <span class="relevance-count">${relevant.length}</span>`;

    const content = document.createElement('div');
    content.className = 'tab-relevance-content';

    relevant.forEach(tab => {
      const pct = Math.round(tab.score * 100);
      const hue = domainToHue(tab.url);
      const item = document.createElement('div');
      item.className = 'tab-relevance-item';
      if (focusedTabId === tab.tabId) item.classList.add('focused');

      const titleEl = document.createElement('span');
      titleEl.className = 'tab-relevance-title';
      titleEl.textContent = tab.title || tab.url;
      titleEl.title = tab.url;

      const barWrap = document.createElement('div');
      barWrap.className = 'tab-relevance-bar';
      barWrap.title = `${pct}% relevance`;

      const barFill = document.createElement('div');
      barFill.className = 'tab-relevance-bar-fill';
      barFill.style.width = pct + '%';
      barFill.style.setProperty('--bar-hue', hue);
      barWrap.appendChild(barFill);

      const scoreEl = document.createElement('span');
      scoreEl.className = 'tab-relevance-score';
      scoreEl.textContent = pct + '%';

      item.appendChild(titleEl);
      item.appendChild(barWrap);
      item.appendChild(scoreEl);

      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        if (focusedTabId === tab.tabId) {
          focusedTabId = null;
          item.classList.remove('focused');
        } else {
          content.querySelectorAll('.tab-relevance-item.focused').forEach(el => el.classList.remove('focused'));
          focusedTabId = tab.tabId;
          item.classList.add('focused');
        }
      });

      content.appendChild(item);
    });

    if (irrelevant.length > 0) {
      const irDetails = document.createElement('details');
      irDetails.className = 'irrelevant-tabs';

      const irSummary = document.createElement('summary');
      irSummary.textContent = msg('IRRELEVANT_TABS_LABEL', [String(irrelevant.length), irrelevant.length > 1 ? 's' : '']);
      irDetails.appendChild(irSummary);

      irrelevant.forEach(tab => {
        const item = document.createElement('div');
        item.className = 'tab-relevance-item dim';

        const titleEl = document.createElement('span');
        titleEl.className = 'tab-relevance-title';
        titleEl.textContent = tab.title || tab.url;
        item.appendChild(titleEl);

        const scoreEl = document.createElement('span');
        scoreEl.className = 'tab-relevance-score';
        scoreEl.textContent = '0%';
        item.appendChild(scoreEl);

        irDetails.appendChild(item);
      });
      content.appendChild(irDetails);
    }

    details.appendChild(summary);
    details.appendChild(content);
    wrapper.appendChild(details);
    messagesEl.appendChild(wrapper);
    scrollToBottom();
  }

  // ── No-match warning with search links ─────────────────────────────────────

  /**
   * Display a warning banner when no indexed tabs match the user's query.
   * Extracts keywords (≥3 chars) from the query and renders them as clickable
   * Google Search chips, giving the user a quick path to find relevant content.
   * Appended directly to the messages container below the query.
   * @param {string} query  The user's original query text that produced zero tab matches.
   */
  function showNoMatchWarning(query) {
    const words = query
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3)
      .slice(0, 5);

    const warning = document.createElement('div');
    warning.className = 'no-match-warning';

    const chips = words.map(w =>
      `<a href="https://www.google.com/search?q=${encodeURIComponent(w)}" target="_blank" class="search-chip">${escHtml(w)}</a>`
    ).join(' ');

    warning.innerHTML = `${msg('NO_MATCH_WARNING')} ${chips}`;
    messagesEl.appendChild(warning);
  }

  // ── Message rendering ───────────────────────────────────────────────────────

  /**
   * Create and append a user message bubble to the chat messages container.
   * Hides the welcome/empty-indexed screens, escapes HTML in the text,
   * preserves newlines as <br>, and scrolls to the bottom of the chat.
   * @param {string} text  Raw user input text to display.
   */
  function appendUserMessage(text) {
    hideWelcome();
    const el = createMessageEl('user', escHtml(text).replace(/\n/g, '<br>'));
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  /**
   * Create and append a new assistant message bubble to the chat.
   * Initializes the streaming state: sets the start timestamp, inserts
   * a loading spinner placeholder, and starts the elapsed-time progress timer.
   * Must be called before appendChunk() for a new response.
   */
  function startAssistantMessage() {
    hideWelcome();
    streamStartTime = Date.now();
    if (srStreamStatus) srStreamStatus.textContent = 'Generating response...';
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `
      <div class="msg-avatar">&#9672;</div>
      <div class="msg-body">
        <div class="msg-role">${msg('ROLE_ASSISTANT')}</div>
        <div class="msg-text"><span class="loading-spinner">${msg('THINKING_SPINNER')}</span></div>
        <div class="stream-progress"></div>
        <div class="msg-actions"></div>
      </div>
    `;
    messagesEl.appendChild(el);
    currentAssistantEl = el.querySelector('.msg-text');
    currentAssistantText = '';
    startStreamTimer(el.querySelector('.stream-progress'));
    scrollToBottom();
  }

  /**
   * Start the elapsed-time display timer for an active AI stream.
   * Updates the progress element every 100ms with word count and seconds elapsed.
   * Clears any previously running stream timer before starting.
   * @param {HTMLElement|null} progressEl  The .stream-progress element to update.
   */
  function startStreamTimer(progressEl) {
    clearInterval(streamTimerInterval);
    if (!progressEl) return;
    streamTimerInterval = setInterval(() => {
      updateStreamProgress(progressEl);
    }, 100);
  }

  /**
   * Update the stream progress indicator with current word count and elapsed time.
   * Reads the accumulated assistant text and computes metrics from streamStartTime.
   * Shows "Xs" if no words yet, or "N words · Xs" once content is arriving.
   * @param {HTMLElement|null} progressEl  The .stream-progress element to update. No-op if null.
   */
  function updateStreamProgress(progressEl) {
    if (!progressEl) return;
    const elapsed = ((Date.now() - streamStartTime) / 1000).toFixed(1);
    const words = currentAssistantText ? currentAssistantText.trim().split(/\s+/).length : 0;
    progressEl.textContent = words > 0 ? `${words} words \u00B7 ${elapsed}s` : `${elapsed}s`;
  }

  /**
   * Append a text chunk from the streaming response to the current assistant bubble.
   * Lazily creates the assistant message if one doesn't exist yet (first chunk).
   * Re-renders the full accumulated markdown on each chunk for consistent formatting.
   * @param {string} text  Incremental text chunk from the LLM stream.
   */
  function appendChunk(text) {
    if (!currentAssistantEl) startAssistantMessage();
    currentAssistantText += text;

    const rendered = renderMarkdown(currentAssistantText);
    currentAssistantEl.innerHTML = rendered + '<span class="cursor"></span>';
    attachChipListeners(currentAssistantEl);
    scrollToBottom();
  }

  /**
   * Finalize a completed streaming response. Stops the progress timer,
   * renders the final markdown without cursor, attaches message action buttons
   * (copy, regenerate), persists the conversation, and triggers follow-up
   * suggestion generation. Also renders any mermaid diagrams in the response.
   */
  function finishStreaming(tokenInfo) {
    clearInterval(streamTimerInterval);
    streamTimerInterval = null;
    if (srStreamStatus) srStreamStatus.textContent = 'Response complete.';

    if (currentAssistantEl) {
      const rendered = renderMarkdown(currentAssistantText);
      currentAssistantEl.innerHTML = rendered;
      attachChipListeners(currentAssistantEl);

      const msgEl = currentAssistantEl.closest('.msg');
      if (msgEl) {
        attachMsgActions(msgEl, 'assistant');
        const progressEl = msgEl.querySelector('.stream-progress');
        if (progressEl && currentAssistantText) {
          const elapsed = ((Date.now() - streamStartTime) / 1000).toFixed(1);
          const words = currentAssistantText.trim().split(/\s+/).length;
          let progressText = `${words} words \u00B7 ${elapsed}s`;
          if (tokenInfo) {
            progressText += ` \u00B7 ${tokenInfo.inputTokens}\u2192${tokenInfo.outputTokens} tok`;
          }
          progressEl.textContent = progressText;
          progressEl.classList.add('done');
          setTimeout(() => progressEl.remove(), 4000);
        } else if (progressEl) {
          progressEl.remove();
        }
      }

      if (currentAssistantText) {
        messages.push({ role: 'assistant', content: currentAssistantText });
        persistConversation();
      }
      currentAssistantText = '';
    }
    currentAssistantEl = null;
    isStreaming = false;
    sendBtn.disabled = false;
    inputEl.disabled = false;
    if (stopBtn) stopBtn.classList.add('hidden');
    updateStatus(hasApiKey ? 'ok' : 'none');
    if (exportBtn && messages.length > 0) exportBtn.style.display = '';
    scrollToBottom();
    requestTabCount();
    requestCoherence();

    // Render any mermaid diagrams in the last assistant message
    const lastMsg = messagesEl.querySelector('.msg.assistant:last-of-type');
    if (lastMsg) {
      renderMermaidBlocks(lastMsg);
    }

    // After the main response, fetch follow-up suggestions
    if (hasApiKey) {
      fetchFollowUpSuggestions();
    }
  }

  /**
   * Display an error message inside the current assistant bubble.
   * Creates the assistant bubble first if it doesn't exist (e.g. pre-stream error).
   * Appends a styled error div below any partial response content.
   * @param {string} msg  Human-readable error message to display.
   */
  function showError(msg) {
    if (!currentAssistantEl) startAssistantMessage();
    // Remove cursor if present
    currentAssistantEl.innerHTML = currentAssistantEl.innerHTML.replace(/<span class="cursor"><\/span>/, '');

    const errEl = document.createElement('div');
    errEl.className = 'msg-error';
    errEl.textContent = msg;
    errEl.setAttribute('role', 'alert');
    currentAssistantEl.closest('.msg-body').appendChild(errEl);
    scrollToBottom();
  }

  function createMessageEl(role, htmlContent) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.setAttribute('role', 'article');
    const avatar = role === 'user' ? '&#128100;' : '&#9672;';
    const roleLabel = role === 'user' ? msg('ROLE_USER') : msg('ROLE_ASSISTANT');
    el.setAttribute('aria-label', `${roleLabel} message`);
    el.innerHTML = `
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-body">
        <div class="msg-role">${roleLabel}</div>
        <div class="msg-text">${htmlContent}</div>
        <div class="msg-actions"></div>
      </div>
    `;
    attachMsgActions(el, role);
    return el;
  }

  function showQuotaWarning() {
    if (document.getElementById('quota-warning-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'quota-warning-banner';
    Object.assign(banner.style, {
      background: '#7c4a00', color: '#ffe0a3', padding: '8px 12px',
      fontSize: '12px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', gap: '8px',
    });
    banner.textContent = msg('ERROR_QUOTA_WARNING') || 'Storage quota exceeded — some tab data may not be saved.';
    const dismiss = document.createElement('button');
    Object.assign(dismiss.style, {
      background: 'none', border: 'none', color: 'inherit', cursor: 'pointer',
      fontSize: '16px', lineHeight: '1', padding: '0',
    });
    dismiss.textContent = '\u00d7';
    dismiss.addEventListener('click', () => banner.remove());
    banner.appendChild(dismiss);
    document.body.prepend(banner);
  }

  // ── Message action bar ──────────────────────────────────────────────────────

  const SVG_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11"/></svg>';
  const SVG_REGEN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 8a5.5 5.5 0 0 1 9.9-3.2M13.5 8a5.5 5.5 0 0 1-9.9 3.2"/><path d="M12.4 2v3h-3M3.6 14v-3h3"/></svg>';
  const SVG_EDIT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9.5 2.5l4 4L5 15H1v-4z"/><path d="M7.5 4.5l4 4"/></svg>';
  const SVG_FORGET = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2l12 12"/><path d="M14 2L2 14"/></svg>';

  /**
   * Attach action buttons (copy, regenerate/edit, forget) to a chat message element.
   * Only populates the action bar once — subsequent calls on the same element are no-ops.
   * Assistant messages get a "regenerate" button; user messages get an "edit" button.
   * @param {HTMLElement} msgEl  The `.msg` container element to attach actions to.
   * @param {'user'|'assistant'} role  The message role, determining which actions are shown.
   */
  function attachMsgActions(msgEl, role) {
    const bar = msgEl.querySelector('.msg-actions');
    if (!bar || bar.children.length > 0) return;

    bar.appendChild(makeActionBtn(SVG_COPY, msg('msgActionCopy'), () => handleCopy(msgEl, bar)));

    if (role === 'assistant') {
      bar.appendChild(makeActionBtn(SVG_REGEN, msg('msgActionRegenerate'), () => handleRegenerate(msgEl)));
    }
    if (role === 'user') {
      bar.appendChild(makeActionBtn(SVG_EDIT, msg('msgActionEdit'), () => handleEdit(msgEl)));
    }
    bar.appendChild(makeActionBtn(SVG_FORGET, msg('msgActionForget') || 'Forget', () => handleForget(msgEl, role)));
  }

  /**
   * Create a small icon button for the message action bar.
   * @param {string} svgHtml  Raw SVG markup for the button icon.
   * @param {string} tooltip  Tooltip text shown on hover (from i18n).
   * @param {function(): void} onClick  Click handler callback.
   * @returns {HTMLButtonElement} Configured button element ready for DOM insertion.
   */
  function makeActionBtn(svgHtml, tooltip, onClick) {
    const btn = document.createElement('button');
    btn.className = 'msg-action-btn';
    btn.innerHTML = svgHtml;
    btn.title = tooltip;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Copy a message's plain text content to the clipboard.
   * Shows a brief "copied" visual confirmation on the copy button (1.5s).
   * Silently fails if clipboard API is unavailable (e.g., insecure context).
   * @param {HTMLElement} msgEl  The `.msg` container whose text to copy.
   * @param {HTMLElement} bar  The `.msg-actions` bar containing the copy button for visual feedback.
   */
  function handleCopy(msgEl, bar) {
    const textEl = msgEl.querySelector('.msg-text');
    if (!textEl) return;
    const plainText = textEl.innerText || textEl.textContent || '';
    navigator.clipboard.writeText(plainText).then(() => {
      const copyBtn = bar.querySelector('.msg-action-btn');
      if (!copyBtn) return;
      copyBtn.classList.add('copied');
      const orig = copyBtn.title;
      copyBtn.title = msg('msgActionCopied');
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.title = orig;
      }, 1500);
    }).catch(() => {});
  }

  /**
   * Regenerate an assistant response by re-sending the preceding user query.
   * Removes the target assistant message and all subsequent messages from both
   * the DOM and the messages array, then triggers a fresh send() with the
   * original user text. No-op while a stream is already in progress.
   * @param {HTMLElement} msgEl  The assistant `.msg` element to regenerate.
   */
  function handleRegenerate(msgEl) {
    if (isStreaming) return;

    const allMsgEls = Array.from(messagesEl.querySelectorAll('.msg'));
    const idx = allMsgEls.indexOf(msgEl);

    const msgIdx = findMsgIndexForEl(msgEl, 'assistant');
    if (msgIdx === -1) return;

    const precedingUserIdx = messages.slice(0, msgIdx).findLastIndex(m => m.role === 'user');
    if (precedingUserIdx === -1) return;

    const userText = messages[precedingUserIdx].content;

    messages.splice(msgIdx);
    persistConversation();

    const domAfter = allMsgEls.slice(idx);
    domAfter.forEach(el => el.remove());
    messagesEl.querySelectorAll('.follow-up-chips').forEach(el => el.remove());
    suggestionContainerEl = null;

    inputEl.value = userText;
    autoResizeInput();
    send();
  }

  /**
   * Edit a user message by removing it and all subsequent messages, then
   * placing its text back into the input field for modification.
   * The user can then modify and re-send. No-op while streaming.
   * @param {HTMLElement} msgEl  The user `.msg` element to edit.
   */
  function handleEdit(msgEl) {
    if (isStreaming) return;

    const allMsgEls = Array.from(messagesEl.querySelectorAll('.msg'));
    const idx = allMsgEls.indexOf(msgEl);

    const msgIdx = findMsgIndexForEl(msgEl, 'user');
    if (msgIdx === -1) return;

    const userText = messages[msgIdx].content;

    messages.splice(msgIdx);
    persistConversation();

    const domAfter = allMsgEls.slice(idx);
    domAfter.forEach(el => el.remove());
    messagesEl.querySelectorAll('.follow-up-chips').forEach(el => el.remove());
    suggestionContainerEl = null;

    if (exportBtn && messages.length === 0) exportBtn.style.display = 'none';

    inputEl.value = userText;
    autoResizeInput();
    inputEl.focus();
  }

  /**
   * Find the index in the messages[] array corresponding to a DOM message element.
   * Uses positional mapping (DOM order === array order) with a role sanity check.
   * @param {HTMLElement} msgEl  The `.msg` DOM element to look up.
   * @param {'user'|'assistant'} expectedRole  Expected role at that index for validation.
   * @returns {number} Index into messages[], or -1 if not found or role mismatch.
   */
  function findMsgIndexForEl(msgEl, expectedRole) {
    const allMsgEls = Array.from(messagesEl.querySelectorAll('.msg'));
    const domIdx = allMsgEls.indexOf(msgEl);
    if (domIdx === -1) return -1;
    if (domIdx < messages.length && messages[domIdx]?.role === expectedRole) return domIdx;
    return -1;
  }

  /**
   * Toggle the "forgotten" state of a message. Forgotten messages are visually
   * dimmed and excluded from the conversation context sent to the AI on the next query.
   * Toggling again restores ("remembers") the message. No-op while streaming.
   * @param {HTMLElement} msgEl  The `.msg` element to toggle forgotten state on.
   * @param {'user'|'assistant'} role  The message's role for index lookup validation.
   */
  function handleForget(msgEl, role) {
    if (isStreaming) return;
    const msgIdx = findMsgIndexForEl(msgEl, role);
    if (msgIdx === -1) return;

    const m = messages[msgIdx];
    m.forgotten = !m.forgotten;
    msgEl.classList.toggle('forgotten', m.forgotten);

    const forgetBtn = msgEl.querySelector('.msg-actions .msg-action-btn:last-child');
    if (forgetBtn) {
      forgetBtn.title = m.forgotten
        ? (msg('msgActionRemember') || 'Remember')
        : (msg('msgActionForget') || 'Forget');
    }

    persistConversation();
  }

  // ── Follow-up suggestions ───────────────────────────────────────────────────

  function fetchFollowUpSuggestions() {
    if (!port || !messages.length) return;

    // Find the last assistant message text
    const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistantMsg) return;

    isFetchingSuggestions = true;
    suggestionText = '';

    // Create a hidden container for suggestions (shown after streaming done)
    suggestionContainerEl = document.createElement('div');
    suggestionContainerEl.className = 'follow-up-chips hidden';
    // Insert after the last message
    const lastMsg = messagesEl.lastElementChild;
    if (lastMsg) {
      messagesEl.insertBefore(suggestionContainerEl, lastMsg.nextSibling);
    } else {
      messagesEl.appendChild(suggestionContainerEl);
    }

    // Show loading mini-spinner
    suggestionContainerEl.innerHTML = `<span class="suggestion-loading">${msg('GENERATING_SUGGESTIONS')}</span>`;
    suggestionContainerEl.classList.remove('hidden');

    const suggestionMessages = [
      ...messages.slice(-10),
      {
        role: 'user',
        content: 'Based on your last answer and the conversation context, suggest exactly 3 short follow-up questions the user might ask. Respond with ONLY 3 lines, each starting with a number (1., 2., 3.). Keep each question under 80 characters. Do NOT add any other text.'
      }
    ];

    try {
      port.postMessage({
        type: 'CHAT',
        messages: suggestionMessages,
        activeTabId: null,
        isResearch: false
      });
    } catch (err) {
      console.warn('[OC sidepanel:fetchFollowUpSuggestions]', err);
      isFetchingSuggestions = false;
      suggestionContainerEl?.remove();
      suggestionContainerEl = null;
    }
  }

  function finalizeSuggestions() {
    isFetchingSuggestions = false;

    if (!suggestionContainerEl) return;

    // Parse the suggestion text into individual questions
    const questions = parseSuggestionText(suggestionText);

    if (questions.length === 0) {
      suggestionContainerEl.remove();
      suggestionContainerEl = null;
      return;
    }

    // Render suggestion chips
    suggestionContainerEl.innerHTML = '';
    questions.forEach(q => {
      const chip = document.createElement('button');
      chip.className = 'follow-up-chip';
      chip.textContent = q;
      chip.addEventListener('click', () => {
        inputEl.value = q;
        autoResizeInput();
        send();
      });
      suggestionContainerEl.appendChild(chip);
    });

    suggestionContainerEl.classList.remove('hidden');
    scrollToBottom();
  }

  function parseSuggestionText(text) {
    if (!text) return [];

    const questions = [];
    const lines = text.split('\n').filter(l => l.trim());

    for (const line of lines) {
      // Strip numbering: "1. Question" → "Question"
      const cleaned = line.replace(/^\d+[\.\)\-]\s*/, '').trim();
      if (cleaned.length > 5 && cleaned.length < 120) {
        // Remove trailing punctuation variations but keep ?
        const final = cleaned.replace(/[.!]+$/, '') + '?';
        questions.push(final);
      }
    }

    // Limit to 3
    return questions.slice(0, 3);
  }

  // ── Token budget display ─────────────────────────────────────────────────────

  function updateTokenBudget(used, max, model) {
    if (!tokenBudgetEl) return;
    const pct = Math.min(100, Math.round((used / max) * 100));
    const usedK = (used / 1000).toFixed(1);
    const maxK = (max / 1000).toFixed(0);

    tokenBudgetLabel.textContent = `${usedK}K / ${maxK}K`;
    tokenBudgetFill.style.width = pct + '%';

    tokenBudgetFill.classList.toggle('warning', pct >= 60 && pct < 80);
    tokenBudgetFill.classList.toggle('danger', pct >= 80);

    tokenBudgetEl.classList.remove('hidden');
    tokenBudgetEl.title = msg('TOKEN_BUDGET_TITLE', [String(pct), model]) || `${pct}% of ${model} context used`;
  }

  // ── Markdown rendering ──────────────────────────────────────────────────────

  /**
   * Render raw assistant text as HTML using marked.js, then post-process
   * to convert [Tab: title] citation markers into interactive source chips.
   * Falls back to escaped plaintext with <br> line breaks on parse errors.
   * @param {string} text  Raw markdown text from the AI assistant response.
   * @returns {string} Sanitized HTML string ready for innerHTML insertion.
   */
  function renderMarkdown(text) {
    if (!text) return '';
    try {
      const rawHtml = marked.parse(text);
      return parseTabMarkers(rawHtml);
    } catch (err) {
      console.warn('[OC sidepanel:renderMarkdown]', err);
      return escHtml(text).replace(/\n/g, '<br>');
    }
  }

  /**
   * Replace [Tab: <title>] citation markers in HTML with clickable source chip elements.
   * Looks up each title in sourcesMap to resolve favicon URLs for inline display.
   * All output is HTML-escaped to prevent XSS from AI-generated tab titles.
   * @param {string} html  Pre-rendered HTML from marked.parse() containing [Tab: ...] markers.
   * @returns {string} HTML with citation markers replaced by interactive <span class="source-chip"> elements.
   */
  function parseTabMarkers(html) {
    // Replace [Tab: <title>] patterns with clickable chips
    return html.replace(/\[Tab:\s*([^\]]+?)\]/g, (_, title) => {
      const t = title.trim();
      const escapedAttr = t.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const escapedText = escHtml(t);
      const info = sourcesMap.get(t);
      const faviconHtml = info?.favicon
        ? `<img class="source-chip-favicon" src="${escHtml(info.favicon)}" alt="" onerror="this.style.display='none'" />`
        : '';
      return `<span class="source-chip clickable" data-tab-title="${escapedAttr}">${faviconHtml}${escapedText}<span class="source-chip-action-btn" title="Actions">&#9660;</span></span>`;
    });
  }

  /**
   * Retroactively inject favicon <img> elements into existing source chips
   * that were rendered before their favicon URL was resolved from chrome.tabs.
   * Skips chips that already have a favicon element to avoid duplicates.
   */
  function updateChipFavicons() {
    messagesEl.querySelectorAll('.source-chip.clickable').forEach(chip => {
      if (chip.querySelector('.source-chip-favicon')) return;
      const title = chip.dataset.tabTitle;
      const info = sourcesMap.get(title);
      if (info?.favicon) {
        const img = document.createElement('img');
        img.className = 'source-chip-favicon';
        img.src = info.favicon;
        img.alt = '';
        img.onerror = () => { img.style.display = 'none'; };
        chip.insertBefore(img, chip.firstChild);
      }
    });
  }

  function attachChipListeners(container) {
    container.querySelectorAll('.source-chip.clickable').forEach(chip => {
      // Avoid double-binding
      if (chip.dataset.bound) return;
      chip.dataset.bound = '1';

      // Left-click: navigate to tab (existing behavior)
      chip.addEventListener('click', (e) => {
        // Don't navigate if clicking the action button
        if (e.target.classList.contains('source-chip-action-btn')) return;
        if (compareMode) {
          handleCompareSelect(chip);
          return;
        }
        navigateToTab(chip);
      });

      // Right-click: show action menu
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showSourceActionMenu(chip, e.clientX, e.clientY);
      });
    });
  }

  function navigateToTab(chip) {
    const title = chip.dataset.tabTitle;
    const info = sourcesMap.get(title);
    const tabId = info?.tabId;
    if (tabId) {
      chrome.tabs.update(tabId, { active: true }).then(() => {
        const snippet = getChipTextWithoutAction(chip)?.trim() || title;
        const highlightQuery = currentQuery.slice(0, 80);
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, {
            type: 'HIGHLIGHT_PASSAGE',
            query: highlightQuery || snippet
          }).catch((err) => { console.warn('[OC sidepanel:navigateToTab:highlight]', err); });
        }, 300);
      }).catch((err) => { console.warn('[OC sidepanel:navigateToTab:activate]', err); });
    }
  }

  function getChipTextWithoutAction(chip) {
    const clone = chip.cloneNode(true);
    const btn = clone.querySelector('.source-chip-action-btn');
    if (btn) btn.remove();
    const favicon = clone.querySelector('.source-chip-favicon');
    if (favicon) favicon.remove();
    return clone.textContent?.trim() || '';
  }

  // ── Source chip action menu ─────────────────────────────────────────────────

  function showSourceActionMenu(chip, x, y) {
    removeSourceActionMenu();

    const title = chip.dataset.tabTitle;
    const menu = document.createElement('div');
    menu.id = 'source-action-menu';
    menu.className = 'source-action-menu';

    const actions = [
      { icon: '\uD83D\uDD17', label: msg('ACTION_GO_TO_TAB'), action: () => navigateToTab(chip) },
      { icon: '\uD83D\uDD0D', label: msg('ACTION_DIVE_DEEPER'), action: () => {
        inputEl.value = msg('ACTION_DIVE_DEEPER_PROMPT', [title]);
        autoResizeInput();
        send();
      }},
      { icon: '\u2696\uFE0F', label: msg('ACTION_COMPARE_WITH'), action: () => enterCompareMode(chip) },
      { icon: '\u2753', label: msg('ACTION_WHAT_IS_MISSING'), action: () => {
        inputEl.value = msg('ACTION_WHAT_MISSING_PROMPT', [title]);
        autoResizeInput();
        send();
      }},
      { icon: '\uD83D\uDCCC', label: getDomainPinLabel(title), action: () => togglePinDomain(title) },
      { icon: '\uD83D\uDEAB', label: getDomainExcludeLabel(title), action: () => toggleExcludeDomain(title) }
    ];

    actions.forEach(a => {
      const item = document.createElement('button');
      item.className = 'source-action-item';
      item.innerHTML = `<span class="source-action-icon">${a.icon}</span><span>${a.label}</span>`;
      item.addEventListener('click', () => {
        removeSourceActionMenu();
        a.action();
      });
      menu.appendChild(item);
    });

    // Position menu
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const panelRect = document.body.getBoundingClientRect();
    let posX = x;
    let posY = y;

    // Keep within viewport
    if (posX + rect.width > panelRect.right - 8) posX = panelRect.right - rect.width - 8;
    if (posY + rect.height > panelRect.bottom - 8) posY = panelRect.bottom - rect.height - 8;

    menu.style.left = posX + 'px';
    menu.style.top = posY + 'px';

    // Close on outside click
    requestAnimationFrame(() => {
      document.addEventListener('click', removeSourceActionMenu, { once: true });
    });
  }

  /**
   * Remove the floating source-chip action menu from the DOM if present.
   * Called before showing a new menu or when clicking outside the active menu.
   */
  function removeSourceActionMenu() {
    const existing = document.getElementById('source-action-menu');
    if (existing) existing.remove();
  }

  /**
   * Test whether a hostname matches a domain pattern (used for pin/exclude lists).
   * Supports wildcard patterns like '*.example.com' which match the domain itself
   * and all subdomains. Comparison is case-insensitive.
   * @param {string} hostname  The hostname to test (e.g. 'docs.example.com').
   * @param {string} pattern   The domain pattern (e.g. '*.example.com' or 'example.com').
   * @returns {boolean} True if the hostname matches the pattern.
   */
  function matchesDomainPatternLocal(hostname, pattern) {
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
   * Look up the hostname for a source chip by its tab title.
   * Uses the sourcesMap (populated from AI response attributions) to resolve
   * title → URL, then extracts the hostname.
   * @param {string} title  The exact tab title shown on the source chip.
   * @returns {string|null} Hostname string, or null if title not found or URL invalid.
   */
  function getDomainForTitle(title) {
    const info = sourcesMap.get(title);
    if (!info?.url) return null;
    try { return new URL(info.url).hostname; } catch (_) { return null; }
  }

  /**
   * Get the localized label for the pin/unpin domain action menu item.
   * Returns "Unpin" if the domain is already pinned, "Pin" otherwise.
   * @param {string} title  Tab title to resolve the domain from.
   * @returns {string} Localized action label from chrome.i18n.
   */
  function getDomainPinLabel(title) {
    const domain = getDomainForTitle(title);
    if (domain && pinnedDomains.some(p => matchesDomainPatternLocal(domain, p))) {
      return msg('ACTION_UNPIN_DOMAIN');
    }
    return msg('ACTION_PIN_DOMAIN');
  }

  /**
   * Get the localized label for the exclude/unexclude domain action menu item.
   * Returns "Unexclude" if the domain is already excluded, "Exclude" otherwise.
   * @param {string} title  Tab title to resolve the domain from.
   * @returns {string} Localized action label from chrome.i18n.
   */
  function getDomainExcludeLabel(title) {
    const domain = getDomainForTitle(title);
    if (domain && excludedDomains.some(p => matchesDomainPatternLocal(domain, p))) {
      return msg('ACTION_UNEXCLUDE_DOMAIN');
    }
    return msg('ACTION_EXCLUDE_DOMAIN');
  }

  /**
   * Toggle the pinned state of a domain via the background service worker.
   * Resolves the domain from the tab title, checks current pin state, and sends
   * the appropriate PIN_DOMAIN or UNPIN_DOMAIN message to the background.
   * @param {string} title  Tab title to resolve the domain from.
   */
  function togglePinDomain(title) {
    const domain = getDomainForTitle(title);
    if (!domain) return;
    const isPinned = pinnedDomains.some(p => matchesDomainPatternLocal(domain, p));
    chrome.runtime.sendMessage({ type: isPinned ? 'UNPIN_DOMAIN' : 'PIN_DOMAIN', domain });
  }

  /**
   * Toggle the excluded state of a domain via the background service worker.
   * Resolves the domain from the tab title, checks current exclusion state, and
   * sends the appropriate EXCLUDE_DOMAIN or UNEXCLUDE_DOMAIN message to the background.
   * @param {string} title  Tab title to resolve the domain from.
   */
  function toggleExcludeDomain(title) {
    const domain = getDomainForTitle(title);
    if (!domain) return;
    const isExcluded = excludedDomains.some(p => matchesDomainPatternLocal(domain, p));
    chrome.runtime.sendMessage({ type: isExcluded ? 'UNEXCLUDE_DOMAIN' : 'EXCLUDE_DOMAIN', domain });
  }

  /**
   * Update visual indicators (pinned/excluded CSS classes) on all source chips
   * in the message history. Iterates all clickable chips and toggles 'pinned'
   * and 'excluded' classes based on the current domain lists. Called after
   * pin/exclude state changes to keep the UI in sync.
   */
  function updateChipIndicators() {
    messagesEl.querySelectorAll('.source-chip.clickable').forEach(chip => {
      const title = chip.dataset.tabTitle;
      const domain = getDomainForTitle(title);
      if (!domain) return;
      const isPinned = pinnedDomains.some(p => matchesDomainPatternLocal(domain, p));
      const isExcluded = excludedDomains.some(p => matchesDomainPatternLocal(domain, p));
      chip.classList.toggle('pinned', isPinned);
      chip.classList.toggle('excluded', isExcluded);
    });
  }

  /**
   * Load the user's domain exclusion and pinning lists from chrome.storage.sync.
   * Populates the module-level excludedDomains and pinnedDomains arrays used by
   * the context bar to show pin/exclude chip states and by the background worker
   * to filter indexed content. Falls back to empty arrays on storage failure.
   * @returns {Promise<void>}
   */
  async function loadExclusionPinningState() {
    try {
      const result = await chrome.storage.sync.get(['excludedDomains', 'pinnedDomains']);
      excludedDomains = result.excludedDomains || [];
      pinnedDomains = result.pinnedDomains || [];
    } catch (err) {
      console.warn('[OC sidepanel:loadExclusionPinningState] Failed to load domain lists:', err.message);
      excludedDomains = [];
      pinnedDomains = [];
    }
  }

  function enterCompareMode(firstChip) {
    compareMode = true;
    compareFirstChip = firstChip;
    firstChip.classList.add('comparing');

    // Show banner
    const banner = document.createElement('div');
    banner.className = 'compare-mode-banner';
    const firstTitle = firstChip.dataset.tabTitle;
    banner.textContent = msg('COMPARE_BANNER', [firstTitle]);
    banner.innerHTML += ` <button class="compare-cancel">${msg('COMPARE_CANCEL')}</button>`;
    messagesEl.appendChild(banner);

    banner.querySelector('.compare-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      compareMode = false;
      compareFirstChip = null;
      firstChip.classList.remove('comparing');
      banner.remove();
    });

    scrollToBottom();
  }

  function handleCompareSelect(secondChip) {
    if (!compareFirstChip || secondChip === compareFirstChip) return;

    const title1 = compareFirstChip.dataset.tabTitle;
    const title2 = secondChip.dataset.tabTitle;

    compareMode = false;
    compareFirstChip.classList.remove('comparing');
    compareFirstChip = null;
    const banner = messagesEl.querySelector('.compare-mode-banner');
    if (banner) banner.remove();

    inputEl.value = msg('COMPARE_PROMPT', [title1, title2]);
    autoResizeInput();
    send();
  }

  // ── Slash commands ──────────────────────────────────────────────────────────

  /**
   * Parse and execute a slash command entered in the chat input.
   * Supported commands:
   *   /search <query>   – Opens the context bar and triggers a tab content search.
   *   /compare          – Activates compare mode (click the compare button).
   *   /summarize all    – Sends a summarize-all-tabs prompt to the AI.
   * @param {string} text  The full input text starting with '/'.
   * @returns {boolean} True if the text matched a known slash command and was handled,
   *   false if unrecognized (caller should treat as normal chat message).
   */
  function handleSlashCommand(text) {
    const searchMatch = text.match(/^\/search\s+(.+)/i);
    if (searchMatch) {
      switchView('chat');
      contextBar.open = true;
      if (tabSearchInput) {
        tabSearchInput.value = searchMatch[1];
        tabSearchInput.dispatchEvent(new Event('input'));
        tabSearchInput.focus();
      }
      return true;
    }

    if (/^\/compare$/i.test(text)) {
      const compareBtn = document.getElementById('compare-btn');
      if (compareBtn) compareBtn.click();
      return true;
    }

    if (/^\/summarize\s+all$/i.test(text)) {
      inputEl.value = msg('SLASH_SUMMARIZE_ALL');
      autoResizeInput();
      setTimeout(() => send(), 0);
      return true;
    }

    if (/^\/usage$/i.test(text)) {
      showUsageStats();
      return true;
    }

    return false;
  }

  // ── Send ────────────────────────────────────────────────────────────────────

  async function showUsageStats() {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `
      <div class="msg-avatar">&#9672;</div>
      <div class="msg-body">
        <div class="msg-role">Token Usage</div>
        <div class="msg-text"><span class="loading-spinner">Loading...</span></div>
      </div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();

    try {
      const [daily, weekly] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_DAILY_USAGE' }),
        chrome.runtime.sendMessage({ type: 'GET_WEEKLY_USAGE' })
      ]);

      let html = '<strong>Today</strong><br>';
      html += `Queries: ${daily.queries} &middot; In: ${fmtTokens(daily.input)} &middot; Out: ${fmtTokens(daily.output)}`;
      if (daily.cost && daily.cost.total > 0) {
        html += ` &middot; ~$${daily.cost.total.toFixed(4)}`;
      }

      html += '<br><br><strong>This Week (7d)</strong><br>';
      html += `Queries: ${weekly.queries} &middot; In: ${fmtTokens(weekly.input)} &middot; Out: ${fmtTokens(weekly.output)}`;
      if (weekly.cost && weekly.cost.total > 0) {
        html += ` &middot; ~$${weekly.cost.total.toFixed(4)}`;
      }

      if (weekly.cost && weekly.cost.breakdown.length > 0) {
        html += '<br><br><strong>Cost by Model</strong><br>';
        for (const item of weekly.cost.breakdown) {
          html += `${escHtml(item.model)}: ~$${item.cost.toFixed(4)}<br>`;
        }
      }

      if (Object.keys(weekly.providers).length > 0) {
        html += '<br><strong>By Provider</strong><br>';
        for (const [prov, models] of Object.entries(weekly.providers)) {
          let provIn = 0, provOut = 0;
          for (const m of Object.values(models)) { provIn += m.input; provOut += m.output; }
          html += `${escHtml(prov)}: ${fmtTokens(provIn)} in / ${fmtTokens(provOut)} out<br>`;
        }
      }

      el.querySelector('.msg-text').innerHTML = html;
    } catch (err) {
      el.querySelector('.msg-text').innerHTML = `<span class="msg-error">Failed to load usage: ${escHtml(err.message)}</span>`;
    }
    scrollToBottom();
  }

  /**
   * Format a token count into a human-readable abbreviated string.
   * Uses 'M' suffix for millions, 'k' for thousands, plain number otherwise.
   * @param {number} n  Token count to format.
   * @returns {string} Formatted string (e.g. '1.25M', '42.3k', '750').
   */
  function fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  /**
   * Send the current input text as a chat message to the AI via the background port.
   * Handles the full send lifecycle: slash command detection, API key validation,
   * conversation state management, DOM updates, and message dispatch with retry on
   * port disconnect. No-ops if input is empty or a stream is already in progress.
   * @returns {Promise<void>}
   */
  async function send() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;

    if (text.startsWith('/')) {
      const handled = handleSlashCommand(text);
      if (handled) {
        inputEl.value = '';
        autoResizeInput();
        return;
      }
    }

    if (!hasApiKey) {
      showApiKeyHint();
      return;
    }

    // Remove any existing follow-up chips
    messagesEl.querySelectorAll('.follow-up-chips').forEach(el => el.remove());
    suggestionContainerEl = null;

    currentQuery = text;
    isStreaming = true;
    sendBtn.disabled = true;
    inputEl.disabled = true;
    inputEl.value = '';
    autoResizeInput();
    if (stopBtn) stopBtn.classList.remove('hidden');

    messages.push({ role: 'user', content: text });
    persistConversation();
    appendUserMessage(text);

    let activeTabId = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabId = tab?.id || null;
    } catch (err) { console.warn('[OC sidepanel:send:getActiveTab]', err); }

    startAssistantMessage();

    try {
      const activeMessages = messages.filter(m => !m.forgotten).slice(-10);
      port.postMessage({
        type: 'CHAT',
        messages: activeMessages,
        activeTabId,
        isResearch: researchMode,
        focusedTabId
      });
      focusedTabId = null;
    } catch (_err) {
      // Port may have disconnected — reconnect and retry once
      connectPort();
      setTimeout(() => {
        try {
          const activeMessages = messages.filter(m => !m.forgotten).slice(-10);
          port.postMessage({
            type: 'CHAT',
            messages: activeMessages,
            activeTabId,
            isResearch: researchMode,
            focusedTabId
          });
          focusedTabId = null;
        } catch (e) {
          showError(msg('ERROR_CONNECTION', [e.message]));
          finishStreaming();
        }
      }, 600);
    }
  }

  function cancelStreaming() {
    if (!isStreaming) return;
    try { port.postMessage({ type: 'CANCEL_STREAM' }); } catch (err) { errorLogger.log('sidepanel:cancelStream', err); }
    clearInterval(streamTimerInterval);
    streamTimerInterval = null;
    isStreaming = false;
    sendBtn.disabled = false;
    inputEl.disabled = false;
    if (stopBtn) stopBtn.classList.add('hidden');
    clearTimeout(chunkTimeoutTimer);
    if (currentAssistantEl) {
      const cursor = currentAssistantEl.querySelector('.cursor');
      if (cursor) cursor.remove();
      const progressEl = currentAssistantEl.closest('.msg')?.querySelector('.stream-progress');
      if (progressEl) progressEl.remove();
    }
    updateStatus(hasApiKey ? 'ok' : 'none');
  }

  function showApiKeyHint() {
    const existing = messagesEl.querySelector('.api-key-hint');
    if (existing) return;

    const hint = document.createElement('div');
    hint.className = 'api-key-hint';
    hint.innerHTML = `
      <span>&#9888;&#65039;</span>
      <span>${msg('NO_KEY_HINT_TEXT')} <a id="hint-open-options">${msg('NO_KEY_HINT_LINK')}</a> ${msg('NO_KEY_HINT_SUFFIX')}</span>
    `;
    messagesEl.appendChild(hint);
    hint.querySelector('#hint-open-options').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
    scrollToBottom();
  }

  // ── Input handling ──────────────────────────────────────────────────────────

  function setupInput() {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+Enter / Cmd+Enter: insert newline
          e.preventDefault();
          const start = inputEl.selectionStart;
          const end = inputEl.selectionEnd;
          const text = inputEl.value;
          inputEl.value = text.slice(0, start) + '\n' + text.slice(end);
          inputEl.selectionStart = inputEl.selectionEnd = start + 1;
          autoResizeInput();
        } else if (!e.shiftKey) {
          // Enter: send
          e.preventDefault();
          send();
        }
      }
    });
    inputEl.addEventListener('input', autoResizeInput);
    sendBtn.addEventListener('click', send);
    if (stopBtn) stopBtn.addEventListener('click', cancelStreaming);
    settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    noKeyBanner.addEventListener('click', () => chrome.runtime.openOptionsPage());
  }

  function autoResizeInput() {
    inputEl.style.height = 'auto';
    // Max 5 lines ~150px
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
  }

  // ── Research mode ───────────────────────────────────────────────────────────

  function setupResearchBtn() {
    researchBtn.addEventListener('click', () => {
      if (!isProUser) {
        showUpgradeBanner();
        return;
      }
      researchMode = !researchMode;
      researchBtn.classList.toggle('active', researchMode);
      researchBtn.setAttribute('aria-pressed', String(researchMode));
      inputEl.placeholder = researchMode
        ? msg('PLACEHOLDER_RESEARCH')
        : msg('PLACEHOLDER_ASK');
    });
  }

  // ── Navigation tabs ─────────────────────────────────────────────────────────

  function setupNavTabs() {
    tabBtnChat.addEventListener('click', () => switchView('chat'));
    tabBtnHistory.addEventListener('click', () => {
      switchView('history');
      loadHistory();
    });
  }

  function switchView(view) {
    const isChat = view === 'chat';
    viewChat.classList.toggle('hidden', !isChat);
    viewChat.classList.toggle('active', isChat);
    viewHistory.classList.toggle('hidden', isChat);
    viewHistory.classList.toggle('active', !isChat);
    tabBtnChat.classList.toggle('active', isChat);
    tabBtnHistory.classList.toggle('active', !isChat);
    tabBtnChat.setAttribute('aria-selected', String(isChat));
    tabBtnHistory.setAttribute('aria-selected', String(!isChat));
  }

  // ── History view ────────────────────────────────────────────────────────────

  let allHistorySessions = [];

  async function loadHistory() {
    historyList.innerHTML = '';
    historyEmpty.textContent = msg('LOADING');
    historyList.appendChild(historyEmpty);

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
      allHistorySessions = response.sessions || [];
      renderHistory(allHistorySessions);
    } catch (err) {
      historyEmpty.textContent = msg('HISTORY_LOAD_FAILED');
    }
  }

  function renderHistory(sessions) {
    historyList.innerHTML = '';

    if (sessions.length === 0) {
      historyEmpty.textContent = msg('HISTORY_EMPTY');
      historyList.appendChild(historyEmpty);
      return;
    }

    sessions.forEach(session => {
      const card = buildHistoryCard(session);
      historyList.appendChild(card);
    });
  }

  function buildHistoryCard(session) {
    const card = document.createElement('details');
    card.className = 'history-card';

    // Summary row
    const summary = document.createElement('summary');
    summary.className = 'history-card-summary';

    const meta = document.createElement('div');
    meta.className = 'history-card-meta';

    const timeEl = document.createElement('span');
    timeEl.className = 'history-card-time';
    timeEl.textContent = formatRelativeTime(session.timestamp);

    const firstUserMsg = session.messages?.find(m => m.role === 'user');
    const preview = document.createElement('span');
    preview.className = 'history-card-preview';
    preview.textContent = firstUserMsg?.content || '(empty)';

    meta.appendChild(timeEl);
    meta.appendChild(preview);

    const badges = document.createElement('div');
    badges.className = 'history-card-badges';

    if (session.model) {
      const modelBadge = document.createElement('span');
      modelBadge.className = 'history-badge';
      modelBadge.textContent = session.model.split('/').pop().slice(0, 14);
      badges.appendChild(modelBadge);
    }

    if (session.isResearch) {
      const rBadge = document.createElement('span');
      rBadge.className = 'history-badge';
      rBadge.textContent = '\uD83D\uDD2C';
      rBadge.title = msg('HISTORY_RESEARCH_MODE');
      badges.appendChild(rBadge);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'history-delete-btn';
    delBtn.textContent = '\u00D7';
    delBtn.title = msg('HISTORY_DELETE_SESSION');
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await chrome.runtime.sendMessage({ type: 'DELETE_HISTORY_ITEM', id: session.id });
      allHistorySessions = allHistorySessions.filter(s => s.id !== session.id);
      renderHistory(filterHistorySessions(historySearch.value));
    });

    summary.appendChild(meta);
    summary.appendChild(badges);
    summary.appendChild(delBtn);
    card.appendChild(summary);

    // Expanded body
    const body = document.createElement('div');
    body.className = 'history-card-body';

    // Messages
    const msgsDiv = document.createElement('div');
    msgsDiv.className = 'history-messages';

    (session.messages || []).forEach(m => {
      const msgEl = document.createElement('div');
      msgEl.className = `history-msg ${m.role}`;
      if (m.role === 'assistant') {
        msgEl.innerHTML = renderMarkdown(m.content);
      } else {
        msgEl.textContent = m.content;
      }
      msgsDiv.appendChild(msgEl);
    });
    body.appendChild(msgsDiv);

    // Tab restoration
    const tabs = session.tabs || [];
    if (tabs.length > 0) {
      const tabSection = document.createElement('div');
      tabSection.className = 'history-tabs-section';

      const header = document.createElement('div');
      header.className = 'history-tabs-header';

      const label = document.createElement('span');
      label.className = 'history-tabs-label';
      label.textContent = msg('TABS_SECTION_LABEL', [String(tabs.length)]);
      header.appendChild(label);

      const openAllBtn = document.createElement('button');
      openAllBtn.className = 'btn-open-all';
      openAllBtn.textContent = msg('HISTORY_OPEN_ALL');
      openAllBtn.addEventListener('click', () => {
        const urls = tabs.map(t => t.url).filter(Boolean);
        urls.forEach(url => chrome.tabs.create({ url }));
      });
      header.appendChild(openAllBtn);
      tabSection.appendChild(header);

      tabs.forEach(tab => {
        const item = document.createElement('div');
        item.className = 'history-tab-item';

        const titleEl = document.createElement('span');
        titleEl.className = 'history-tab-title';
        titleEl.textContent = tab.title || tab.url;
        titleEl.title = tab.url;

        const openBtn = document.createElement('button');
        openBtn.className = 'btn-open-tab';
        openBtn.textContent = '\u2197';
        openBtn.title = msg('HISTORY_OPEN_TAB');
        openBtn.addEventListener('click', () => {
          if (tab.url) chrome.tabs.create({ url: tab.url });
        });

        item.appendChild(titleEl);
        item.appendChild(openBtn);
        tabSection.appendChild(item);
      });

      body.appendChild(tabSection);
    }

    card.appendChild(body);
    return card;
  }

  function filterHistorySessions(query) {
    if (!query.trim()) return allHistorySessions;
    const q = query.toLowerCase();
    return allHistorySessions.filter(s => {
      return (s.messages || []).some(m => m.content?.toLowerCase().includes(q)) ||
             (s.tabs || []).some(t => t.title?.toLowerCase().includes(q)) ||
             s.model?.toLowerCase().includes(q);
    });
  }

  // ── Tab groups ──────────────────────────────────────────────────────────────

  async function loadTabGroups() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_TAB_GROUPS' });
      tabGroups = (resp?.groups || []).filter(g => g.title);
      if (tabGroups.length > 0) updateContextTabList(latestAllTabs);
    } catch (err) { console.warn('[OC sidepanel:loadTabGroups]', err); }
  }

  // ── History search ──────────────────────────────────────────────────────────

  historySearch.addEventListener('input', () => {
    renderHistory(filterHistorySessions(historySearch.value));
  });

  historyClearBtn.addEventListener('click', async () => {
    if (!confirm(msg('HISTORY_CLEAR_CONFIRM'))) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
    allHistorySessions = [];
    renderHistory([]);
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function hideWelcome() {
    if (welcomeEl) welcomeEl.classList.add('hidden');
    if (emptyIndexedEl) emptyIndexedEl.classList.add('hidden');
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatRelativeTime(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours   = Math.floor(diff / 3600000);
    const days    = Math.floor(diff / 86400000);

    if (diff < 60000)    return msg('TIME_JUST_NOW');
    if (minutes < 60)    return msg('TIME_MINUTES_AGO', [String(minutes)]);
    if (hours < 24)      return msg('TIME_HOURS_AGO', [String(hours)]);
    if (days === 1)      return msg('TIME_YESTERDAY');
    if (days < 7)        return msg('TIME_DAYS_AGO', [String(days)]);

    return new Date(timestamp).toLocaleDateString('en-US', {
      day:   '2-digit',
      month: '2-digit',
      year:  'numeric'
    });
  }

  // ── Pro status ───────────────────────────────────────────────────────────────

  async function loadProStatus() {
    try {
      const result = await chrome.storage.sync.get('omni_pro_status');
      isProUser = result.omni_pro_status === true;
    } catch (err) {
      console.warn('[OC sidepanel:loadProStatus]', err);
      isProUser = false;
    }
    updateProUI();
  }

  function updateProUI() {
    // Badge
    if (tierBadge) {
      tierBadge.textContent = isProUser ? msg('TIER_PRO') : msg('TIER_FREE');
      tierBadge.classList.toggle('pro', isProUser);
      tierBadge.classList.toggle('free', !isProUser);
    }

    // Export button: locked for free users
    if (exportBtn) {
      exportBtn.classList.toggle('locked', !isProUser);
      exportBtn.title = isProUser
        ? msg('EXPORT_TITLE')
        : '\uD83D\uDD12 ' + msg('EXPORT_LOCKED');
    }

    // Research button: locked for free users
    if (researchBtn) {
      researchBtn.classList.toggle('locked', !isProUser);
      if (!isProUser) {
        researchMode = false;
        researchBtn.classList.remove('active');
      }
    }

    // Hide upgrade banner if pro
    if (isProUser && upgradeBanner) {
      upgradeBanner.classList.add('hidden');
    }
  }

  function showUpgradeBanner() {
    if (!upgradeBanner || isProUser) return;
    upgradeBanner.classList.remove('hidden');
  }

  // Wire upgrade banner buttons
  if (upgradeBannerBtn) {
    upgradeBannerBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }
  if (upgradeBannerClose) {
    upgradeBannerClose.addEventListener('click', () => {
      upgradeBanner.classList.add('hidden');
    });
  }

  // ── Storage change listener ─────────────────────────────────────────────────

  async function loadIndexedContentSize() {
    try {
      const result = await chrome.storage.local.get('_oc_indexed_chars');
      indexedContentChars = result['_oc_indexed_chars'] || 0;
      updateContentCountLabel();
    } catch (err) { console.warn('[OC sidepanel:loadIndexedContentSize]', err); }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (changes.apiKey || changes.provider) {
      checkSettings();
    }
    if (changes._oc_indexed_chars) {
      indexedContentChars = changes._oc_indexed_chars.newValue || 0;
      updateContentCountLabel();
    }
    if (area === 'sync' && changes.omni_pro_status) {
      isProUser = changes.omni_pro_status.newValue === true;
      updateProUI();
    }
    if (area === 'sync' && (changes.excludedDomains || changes.pinnedDomains)) {
      if (changes.excludedDomains) excludedDomains = changes.excludedDomains.newValue || [];
      if (changes.pinnedDomains) pinnedDomains = changes.pinnedDomains.newValue || [];
      updateChipIndicators();
    }
  });

  // ── Last indexed time updater ───────────────────────────────────────────────

  function startLastIndexedUpdater() {
    const el = document.getElementById('last-indexed');
    if (!el) return;

    function update() {
      chrome.runtime.sendMessage({ type: 'GET_LAST_INDEXED' }, (resp) => {
        if (chrome.runtime.lastError || !resp?.timestamp) return;
        const ago = Math.round((Date.now() - resp.timestamp) / 1000);
        if (ago < 5) {
          el.textContent = '\u27F3 ' + msg('LAST_INDEXED_JUST_NOW');
        } else if (ago < 60) {
          el.textContent = '\u27F3 ' + msg('LAST_INDEXED_SECONDS_AGO', [String(ago)]);
        } else {
          el.textContent = '\u27F3 ' + msg('LAST_INDEXED_MINUTES_AGO', [String(Math.round(ago / 60))]);
        }
      });
    }

    update();
    setInterval(update, 5000);
  }

  // ── Export session ───────────────────────────────────────────────────────────

  function setupExportBtn() {
    if (!exportBtn) return;
    const exportMenu = document.getElementById('export-menu');
    if (!exportMenu) return;

    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (messages.length === 0) return;
      exportMenu.classList.toggle('hidden');
      const expanded = !exportMenu.classList.contains('hidden');
      exportBtn.setAttribute('aria-expanded', String(expanded));
    });

    document.addEventListener('click', (e) => {
      if (!exportMenu.contains(e.target) && e.target !== exportBtn) {
        exportMenu.classList.add('hidden');
        exportBtn.setAttribute('aria-expanded', 'false');
      }
    });

    exportMenu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-format]');
      if (!item) return;
      exportMenu.classList.add('hidden');
      const format = item.dataset.format;
      if (format === 'clipboard') {
        exportClipboard();
      } else {
        if (!isProUser) { showUpgradeBanner(); return; }
        if (format === 'md') exportMarkdown();
        else if (format === 'json') exportJSON();
        else if (format === 'html') exportHTML();
      }
    });
  }

  // ── New Chat ────────────────────────────────────────────────────────────────

  function setupNewChatBtn() {
    if (!newChatBtn) return;
    newChatBtn.addEventListener('click', newChat);
  }

  function newChat() {
    messages.length = 0;
    currentQuery = '';
    if (researchMode) {
      researchMode = false;
      researchBtn.classList.remove('active');
      inputEl.placeholder = msg('PLACEHOLDER_ASK');
    }
    const children = Array.from(messagesEl.children);
    for (const child of children) {
      if (child.id === 'welcome' || child.id === 'empty-indexed') continue;
      child.remove();
    }
    if (welcomeEl) welcomeEl.classList.remove('hidden');
    if (exportBtn) exportBtn.style.display = 'none';
    chrome.storage.session.remove('omni_conversation').catch(() => {});
  }

  function exportMarkdown() {
    if (messages.length === 0) return;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 16).replace('T', ' ');
    const filename = `omni-context-${now.toISOString().slice(0, 10)}.md`;

    let md = `# Omni-Context Research Export\n\n`;
    md += `**Exported:** ${dateStr}  \n`;
    md += `**Tabs indexed:** ${indexedTabCount}  \n\n`;
    md += `---\n\n## Conversation\n\n`;

    messages.forEach((m, i) => {
      if (m.role === 'user') {
        md += `### You\n\n${m.content}\n\n`;
      } else {
        md += `### Omni-Context\n\n${m.content}\n\n`;
      }
      if (i < messages.length - 1) md += `---\n\n`;
    });

    if (sourcesMap.size > 0) {
      md += `\n---\n\n## Sources Referenced\n\n`;
      for (const [title, info] of sourcesMap) {
        md += `- **${title}**${info.tabId ? ` (tab ${info.tabId})` : ''}\n`;
      }
    }

    if (tabGroups.length > 0) {
      md += `\n---\n\n## Tab Groups\n\n`;
      tabGroups.forEach(g => {
        md += `- **${g.title}**: ${g.tabs.map(t => t.title).filter(Boolean).join(', ')}\n`;
      });
    }

    _downloadBlob(md, filename, 'text/markdown;charset=utf-8');
  }

  function exportJSON() {
    if (messages.length === 0) return;

    const now = new Date();
    const sources = [];
    for (const [title, info] of sourcesMap) {
      sources.push({ title, tabId: info.tabId || null, url: info.url || null });
    }

    const payload = {
      version: 1,
      exported: now.toISOString(),
      tabsIndexed: indexedTabCount,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || null
      })),
      sources
    };

    const json = JSON.stringify(payload, null, 2);
    const filename = `omni-context-${now.toISOString().slice(0, 10)}.json`;
    _downloadBlob(json, filename, 'application/json;charset=utf-8');
  }

  function exportHTML() {
    if (messages.length === 0) return;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 16).replace('T', ' ');
    const filename = `omni-context-${now.toISOString().slice(0, 10)}.html`;

    let body = '';
    messages.forEach(m => {
      const role = m.role === 'user' ? 'You' : 'Omni-Context';
      const cls = m.role === 'user' ? 'user' : 'assistant';
      body += `<div class="msg ${cls}"><strong>${escHtml(role)}</strong><div class="content">${escHtml(m.content)}</div></div>\n`;
    });

    let sourcesHtml = '';
    if (sourcesMap.size > 0) {
      sourcesHtml = '<h2>Sources Referenced</h2><ul>';
      for (const [title] of sourcesMap) {
        sourcesHtml += `<li>${escHtml(title)}</li>`;
      }
      sourcesHtml += '</ul>';
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Omni-Context Export — ${escHtml(dateStr)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #08090a; color: #f7f8f8; max-width: 720px; margin: 0 auto; padding: 24px; line-height: 1.6; }
h1 { color: #828fff; margin-bottom: 4px; }
.meta { color: #8a8f98; font-size: 13px; margin-bottom: 24px; }
.msg { padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; }
.msg.user { background: rgba(255,255,255,0.05); }
.msg.assistant { background: rgba(94,106,210,0.08); border: 1px solid rgba(94,106,210,0.20); }
.msg strong { display: block; font-size: 12px; margin-bottom: 6px; color: #828fff; }
.msg .content { white-space: pre-wrap; word-break: break-word; }
h2 { color: #d0d6e0; margin-top: 32px; font-size: 16px; }
ul { padding-left: 20px; color: #d0d6e0; }
li { margin-bottom: 4px; }
</style>
</head>
<body>
<h1>Omni-Context Export</h1>
<div class="meta">Exported: ${escHtml(dateStr)} · Tabs indexed: ${indexedTabCount}</div>
${body}
${sourcesHtml}
</body>
</html>`;

    _downloadBlob(html, filename, 'text/html;charset=utf-8');
  }

  function exportClipboard() {
    if (messages.length === 0) return;

    let text = '';
    messages.forEach(m => {
      const role = m.role === 'user' ? 'You' : 'Omni-Context';
      text += `${role}:\n${m.content}\n\n`;
    });

    navigator.clipboard.writeText(text.trim()).then(() => {
      _showSuccessToast(msg('EXPORT_COPIED'));
    }).catch(() => {});
  }

  function _downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function _showSuccessToast(message) {
    const existing = document.getElementById('oc-success-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'oc-success-toast';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
      background: '#166534', color: '#fff', padding: '8px 16px', borderRadius: '6px',
      fontSize: '12px', zIndex: '99998', maxWidth: '320px', boxShadow: '0 4px 12px rgba(0,0,0,.4)',
    });
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isStreaming && document.activeElement !== inputEl) {
        e.preventDefault();
        cancelStreaming();
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      // Ctrl/Cmd+K — focus the input
      if (e.key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        switchView('chat');
        inputEl.focus();
        inputEl.select();
        return;
      }

      // Ctrl/Cmd+Shift+M — generate mind map of all indexed content
      if ((e.key === 'M' || e.key === 'm') && e.shiftKey && !e.altKey) {
        e.preventDefault();
        generateMindMap();
        return;
      }

      if ((e.key === 'F' || e.key === 'f') && e.shiftKey && !e.altKey) {
        e.preventDefault();
        switchView('chat');
        contextBar.open = true;
        tabSearchInput?.focus();
        tabSearchInput?.select();
        return;
      }

      // Ctrl/Cmd+Shift+N — new conversation
      if ((e.key === 'N' || e.key === 'n') && e.shiftKey && !e.altKey) {
        e.preventDefault();
        newChat();
        return;
      }

      // Ctrl/Cmd+Shift+E — export conversation
      if ((e.key === 'E' || e.key === 'e') && e.shiftKey && !e.altKey) {
        e.preventDefault();
        exportSession();
        return;
      }
    });

    // Arrow Up in empty input — recall last user message
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && inputEl.value.trim() === '' && !e.ctrlKey && !e.metaKey) {
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          e.preventDefault();
          inputEl.value = lastUserMsg.content;
          autoResizeInput();
        }
      }
    });
  }

  function generateMindMap() {
    if (isStreaming || !hasApiKey) return;
    inputEl.value = 'Create a comprehensive mermaid mindmap diagram showing the main topics, themes, and connections across all my indexed browser tabs.';
    autoResizeInput();
    switchView('chat');
    send();
  }

  // ── Theme live-sync ──────────────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.theme) {
      const val = changes.theme.newValue;
      if (val && val !== 'system') {
        document.documentElement.dataset.theme = val;
      } else {
        delete document.documentElement.dataset.theme;
      }
    }
  });

  // ── Error boundary ──────────────────────────────────────────────────────────

  /** Show a full-screen fallback when init() or an uncaught error blanks the panel. */
  function showFatalError(err) {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'var(--oc-bg, #0f1117)',
      color: 'var(--oc-text, #e2e4f0)', zIndex: '99999', padding: '24px',
    });
    const title = msg('ERROR_BOUNDARY_TITLE') || 'Something went wrong';
    const desc  = msg('ERROR_BOUNDARY_DESC')  || 'The panel encountered an unexpected error.';
    const btn   = msg('ERROR_BOUNDARY_RELOAD') || 'Reload Panel';
    overlay.innerHTML = `
      <div style="max-width:360px;text-align:center;">
        <h2 style="margin:0 0 8px;">${escHtml(title)}</h2>
        <p style="margin:0 0 12px;opacity:.7;">${escHtml(desc)}</p>
        <pre style="text-align:left;font-size:11px;background:rgba(255,255,255,.06);border-radius:6px;padding:10px;max-height:120px;overflow:auto;margin:0 0 16px;word-break:break-all;white-space:pre-wrap;">${escHtml(String(err))}</pre>
        <button class="btn btn-primary" id="fatal-reload-btn">${escHtml(btn)}</button>
      </div>`;
    document.body.innerHTML = '';
    document.body.appendChild(overlay);
    document.getElementById('fatal-reload-btn')?.addEventListener('click', () => location.reload());
  }

  function showErrorToast(message) {
    const existing = document.getElementById('oc-error-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'oc-error-toast';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
      background: '#b91c1c', color: '#fff', padding: '8px 16px', borderRadius: '6px',
      fontSize: '12px', zIndex: '99998', maxWidth: '320px', boxShadow: '0 4px 12px rgba(0,0,0,.4)',
    });
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  window.addEventListener('error', (e) => {
    const err = e.error || e.message || 'Unknown error';
    errorLogger.log('sidepanel:uncaught', err);
    showErrorToast(String(err instanceof Error ? err.message : err).slice(0, 120));
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    errorLogger.log('sidepanel:unhandledRejection', reason);
    showErrorToast(String(reason instanceof Error ? reason.message : reason).slice(0, 120));
  });

  init().catch((err) => {
    console.error('[OC] init failed:', err);
    errorLogger.log('sidepanel:initFailed', err);
    showFatalError(err);
  });
})();
