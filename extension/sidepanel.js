/**
 * Omni-Context sidepanel UI logic — v3.
 * Communicates with background via a long-lived port for streaming.
 */
import { escHtml } from './lib/utils.js';

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

  // ── State ───────────────────────────────────────────────────────────────────

  const messages = [];          // {role, content} conversation history
  let port = null;
  let isStreaming = false;
  let hasApiKey = false;
  let researchMode = false;
  let currentQuery = '';
  let isProUser = false;

  // Source chip map: title → {tabId, favicon} (for chip click navigation)
  const sourcesMap = new Map();

  // All tabs with scores (for context bar list)
  let latestAllTabs = [];

  // Tab groups from Chrome (id → {title, color, tabs[]})
  let tabGroups = [];

  // Current streaming state
  let currentAssistantEl = null;
  let currentAssistantText = '';

  // Follow-up suggestions state
  let isFetchingSuggestions = false;
  let suggestionText = '';
  let suggestionContainerEl = null;

  // Compare mode state
  let compareMode = false;
  let compareFirstChip = null;

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

  function persistConversation() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      chrome.storage.session.set({
        omni_conversation: { messages, currentQuery, researchMode }
      }).catch(err => console.warn('[OC sidepanel:persistConversation]', err));
    }, 200);
  }

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
        } else if (m.role === 'assistant') {
          const el = createMessageEl('assistant', renderMarkdown(m.content));
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

  async function init() {
    localizeHtml();
    document.title = msg('APP_NAME');
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
    await restoreConversation();
    await loadProStatus();
  }

  async function loadPersistedTabCount() {
    try {
      const result = await chrome.storage.local.get('_tabIndex_v1');
      const stored = result['_tabIndex_v1'];
      if (stored && Array.isArray(stored) && stored.length > 0) {
        if (indexedTabCount === 0) {
          indexedTabCount = stored.length;
          updateContextBar(indexedTabCount);
          updateEmptyIndexedState(indexedTabCount);
        }
      }
    } catch (err) { console.warn('[OC sidepanel:loadPersistedTabCount]', err); }
  }

  // ── Mermaid init ────────────────────────────────────────────────────────────

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
      securityLevel: 'loose',
      flowchart: { curve: 'basis' }
    });
  }

  async function renderMermaidBlocks(container) {
    if (typeof mermaid === 'undefined') return;

    const blocks = container.querySelectorAll('pre code.language-mermaid');
    if (!blocks.length) return;

    for (const block of blocks) {
      const pre = block.parentElement;
      if (!pre || pre.tagName !== 'PRE') continue;

      const graphDef = block.textContent;
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

  function getNodeLabel(node) {
    // Extract text content from SVG node
    if (node.tagName === 'text') {
      return node.textContent?.trim();
    }
    const textEl = node.querySelector('text, tspan');
    if (textEl) return textEl.textContent?.trim();

    // For edge labels or group labels
    const labels = node.querySelectorAll('text, tspan');
    if (labels.length > 0) {
      return Array.from(labels).map(l => l.textContent?.trim()).filter(Boolean).join(' ');
    }
    return null;
  }

  // ── Port management + heartbeat ─────────────────────────────────────────────

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

  function requestTabCount() {
    try { port.postMessage({ type: 'GET_TAB_COUNT' }); } catch (err) { console.warn('[OC sidepanel:requestTabCount]', err); }
  }

  function requestCoherence() {
    try { port.postMessage({ type: 'GET_COHERENCE' }); } catch (err) { console.warn('[OC sidepanel:requestCoherence]', err); }
  }

  // ── Settings check ──────────────────────────────────────────────────────────

  async function checkSettings() {
    const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    hasApiKey = !!(settings?.provider && settings?.apiKey);
    updateStatus(hasApiKey ? 'ok' : 'none');
    noKeyBanner.style.display = hasApiKey ? 'none' : 'block';
  }

  // ── Status indicator ────────────────────────────────────────────────────────

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

      case 'SOURCES':
        // Build title→{tabId, favicon} map for chip click navigation
        const sources = msg.sources || [];
        sources.forEach(s => {
          if (s.title && s.tabId) sourcesMap.set(s.title, { tabId: s.tabId, favicon: s.favicon || null });
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
          finishStreaming();
        }
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

  function updateContextBar(count) {
    if (count > 0) {
      if (contextBarTextEl) contextBarTextEl.textContent = msg('CONTEXT_BAR_USING', [String(count)]);
      contextBar.classList.remove('hidden');
      updateContentCountLabel();
    } else {
      contextBar.classList.add('hidden');
    }
  }

  function updateContentCountLabel() {
    if (!contentCountEl) return;
    if (indexedContentChars > 0) {
      const k = (indexedContentChars / 1000).toFixed(1);
      contentCountEl.textContent = msg('CONTENT_COUNT', [k]);
    } else {
      contentCountEl.textContent = '';
    }
  }

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

  function groupColorToHex(color) {
    const map = {
      grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00',
      green: '#1e8e3e', pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#e8710a'
    };
    return map[color] || '#5f6368';
  }

  // ── Tab relevance section (shown before each answer) ────────────────────────

  function showTabRelevance(allTabs) {
    const relevant   = allTabs.filter(t => t.score >= 0.05);
    const irrelevant = allTabs.filter(t => t.score < 0.05);

    // Check if no tabs matched → show no-match warning
    if (allTabs.length > 0 && relevant.length === 0) {
      showNoMatchWarning(currentQuery);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'tab-relevance';

    const details = document.createElement('details');
    details.className = 'tab-relevance-details';
    details.open = relevant.length <= 4; // auto-open if few tabs

    const summary = document.createElement('summary');
    summary.innerHTML = `\uD83D\uDCD1 ${msg('USED_TABS_LABEL')} <span class="relevance-count">${relevant.length}</span>`;

    const content = document.createElement('div');
    content.className = 'tab-relevance-content';

    relevant.forEach(tab => {
      const pct = Math.round(tab.score * 100);
      const item = document.createElement('div');
      item.className = 'tab-relevance-item';

      const titleEl = document.createElement('span');
      titleEl.className = 'tab-relevance-title';
      titleEl.textContent = tab.title || tab.url;
      titleEl.title = tab.url;

      const scoreEl = document.createElement('span');
      scoreEl.className = 'tab-relevance-score';
      scoreEl.textContent = pct + '%';

      item.appendChild(titleEl);
      item.appendChild(scoreEl);
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

  function appendUserMessage(text) {
    hideWelcome();
    const el = createMessageEl('user', escHtml(text).replace(/\n/g, '<br>'));
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function startAssistantMessage() {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `
      <div class="msg-avatar">&#9672;</div>
      <div class="msg-body">
        <div class="msg-role">${msg('ROLE_ASSISTANT')}</div>
        <div class="msg-text"><span class="loading-spinner">${msg('THINKING_SPINNER')}</span></div>
      </div>
    `;
    messagesEl.appendChild(el);
    currentAssistantEl = el.querySelector('.msg-text');
    currentAssistantText = '';
    scrollToBottom();
  }

  function appendChunk(text) {
    if (!currentAssistantEl) startAssistantMessage();
    currentAssistantText += text;

    const rendered = renderMarkdown(currentAssistantText);
    currentAssistantEl.innerHTML = rendered + '<span class="cursor"></span>';
    attachChipListeners(currentAssistantEl);
    scrollToBottom();
  }

  function finishStreaming() {
    if (currentAssistantEl) {
      // Final render without cursor
      const rendered = renderMarkdown(currentAssistantText);
      currentAssistantEl.innerHTML = rendered;
      attachChipListeners(currentAssistantEl);

      // Push to conversation history
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

  function showError(msg) {
    if (!currentAssistantEl) startAssistantMessage();
    // Remove cursor if present
    currentAssistantEl.innerHTML = currentAssistantEl.innerHTML.replace(/<span class="cursor"><\/span>/, '');

    const errEl = document.createElement('div');
    errEl.className = 'msg-error';
    errEl.textContent = msg;
    currentAssistantEl.closest('.msg-body').appendChild(errEl);
    scrollToBottom();
  }

  function createMessageEl(role, htmlContent) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    const avatar = role === 'user' ? '&#128100;' : '&#9672;';
    const roleLabel = role === 'user' ? msg('ROLE_USER') : msg('ROLE_ASSISTANT');
    el.innerHTML = `
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-body">
        <div class="msg-role">${roleLabel}</div>
        <div class="msg-text">${htmlContent}</div>
      </div>
    `;
    return el;
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

  // ── Markdown rendering ──────────────────────────────────────────────────────

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
      }}
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

  function removeSourceActionMenu() {
    const existing = document.getElementById('source-action-menu');
    if (existing) existing.remove();
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

  // ── Send ────────────────────────────────────────────────────────────────────

  async function send() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;

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
      port.postMessage({
        type: 'CHAT',
        messages: messages.slice(-10),
        activeTabId,
        isResearch: researchMode
      });
    } catch (_err) {
      // Port may have disconnected — reconnect and retry once
      connectPort();
      setTimeout(() => {
        try {
          port.postMessage({
            type: 'CHAT',
            messages: messages.slice(-10),
            activeTabId,
            isResearch: researchMode
          });
        } catch (e) {
          showError(msg('ERROR_CONNECTION', [e.message]));
          finishStreaming();
        }
      }, 600);
    }
  }

  function cancelStreaming() {
    if (!isStreaming) return;
    try { port.postMessage({ type: 'CANCEL_STREAM' }); } catch (_) {}
    isStreaming = false;
    sendBtn.disabled = false;
    inputEl.disabled = false;
    if (stopBtn) stopBtn.classList.add('hidden');
    clearTimeout(chunkTimeoutTimer);
    if (currentAssistantEl) {
      const cursor = currentAssistantEl.querySelector('.cursor');
      if (cursor) cursor.remove();
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
    exportBtn.addEventListener('click', exportSession);
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

  function exportSession() {
    if (messages.length === 0) return;
    if (!isProUser) {
      showUpgradeBanner();
      return;
    }

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

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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
    });
  }

  function generateMindMap() {
    if (isStreaming || !hasApiKey) return;
    inputEl.value = 'Create a comprehensive mermaid mindmap diagram showing the main topics, themes, and connections across all my indexed browser tabs.';
    autoResizeInput();
    switchView('chat');
    send();
  }

  init();
})();
