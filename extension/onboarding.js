/**
 * Omni-Context onboarding wizard module.
 * Shows a step-by-step setup flow for new users.
 */
import { PROVIDER_MODELS, escHtml } from './lib/utils.js';

const STORAGE_KEY = '_oc_onboarding_done';
const FREE_PROVIDERS = new Set(['openrouter', 'groq', 'gemini']);

const PROVIDERS = [
  { id: 'groq', icon: '\u26A1', name: 'Groq', free: true },
  { id: 'gemini', icon: '\uD83D\uDCA1', name: 'Gemini', free: true },
  { id: 'openrouter', icon: '\uD83D\uDD01', name: 'OpenRouter', free: true },
  { id: 'openai', icon: '\uD83E\uDD16', name: 'OpenAI', free: false },
  { id: 'anthropic', icon: '\uD83E\uDDE0', name: 'Anthropic', free: false },
  { id: 'deepseek', icon: '\uD83D\uDD0D', name: 'DeepSeek', free: false },
];

const msg = chrome.i18n.getMessage;

/**
 * Determine whether the onboarding wizard should be displayed.
 * Returns false if onboarding was already completed or if the user
 * has a provider and API key configured (i.e., returning user).
 * @returns {Promise<boolean>} True if onboarding should be shown to the user.
 */
export async function shouldShowOnboarding() {
  const data = await chrome.storage.local.get([STORAGE_KEY, 'provider', 'apiKey']);
  if (data[STORAGE_KEY]) return false;
  if (data.provider && data.apiKey) return false;
  return true;
}

/**
 * Mark onboarding as completed by persisting a timestamp to chrome.storage.local.
 * Prevents the wizard from showing again on subsequent opens.
 * @returns {Promise<void>}
 */
export function markOnboardingDone() {
  return chrome.storage.local.set({ [STORAGE_KEY]: Date.now() });
}

/**
 * Reset the onboarding state so the wizard will show again on next open.
 * Useful for debugging or allowing users to re-run the setup flow.
 * @returns {Promise<void>}
 */
export function resetOnboarding() {
  return chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * Launch the onboarding wizard overlay with a 4-step setup flow:
 *   Step 0 — Choose AI provider
 *   Step 1 — Enter and test API key
 *   Step 2 — Wait for 3+ tabs to be indexed
 *   Step 3 — Completion confirmation
 * Creates a DOM overlay, manages port connections for testing and tab polling,
 * and calls onComplete when the user finishes or skips.
 * @param {function(): void} onComplete  Callback invoked when onboarding finishes (done or skipped).
 */
export function runOnboarding(onComplete) {
  let step = 0;
  let selectedProvider = null;
  let apiKey = '';
  let tabCount = 0;
  let port = null;
  let testPassed = false;

  const overlay = document.createElement('div');
  overlay.className = 'ob-overlay';
  overlay.id = 'ob-overlay';
  document.body.appendChild(overlay);

  function render() {
    const dots = [0, 1, 2, 3].map(i => {
      const cls = i === step ? 'active' : i < step ? 'done' : '';
      return `<div class="ob-dot ${cls}"></div>`;
    }).join('');

    let content = '';
    if (step === 0) content = renderProviderStep();
    else if (step === 1) content = renderKeyStep();
    else if (step === 2) content = renderTabsStep();
    else content = renderDoneStep();

    overlay.innerHTML = `<div class="ob-card"><div class="ob-steps">${dots}</div>${content}</div>`;
    bindStepEvents();
  }

  function renderProviderStep() {
    const freeLabel = msg('OB_FREE_LABEL') || 'Free';
    const grid = PROVIDERS.map(p => {
      const sel = p.id === selectedProvider ? ' selected' : '';
      const tag = p.free ? `<span class="ob-free-tag">${freeLabel}</span>` : '';
      return `<button class="ob-provider-btn${sel}" data-pid="${p.id}">${p.icon} ${p.name}${tag}</button>`;
    }).join('');

    return `
      <div class="ob-icon">\u{1F680}</div>
      <div class="ob-title">${msg('OB_STEP_PROVIDER') || 'Choose AI Provider'}</div>
      <div class="ob-desc">${msg('OB_STEP_PROVIDER_DESC') || ''}</div>
      <div class="ob-provider-grid">${grid}</div>
      <div class="ob-actions">
        <button class="ob-btn ob-btn-ghost" id="ob-skip">${msg('OB_BTN_SKIP') || 'Skip'}</button>
        <button class="ob-btn ob-btn-primary" id="ob-next" ${selectedProvider ? '' : 'disabled'}>${msg('OB_BTN_NEXT') || 'Next'}</button>
      </div>`;
  }

  function renderKeyStep() {
    return `
      <div class="ob-icon">\u{1F511}</div>
      <div class="ob-title">${msg('OB_STEP_APIKEY') || 'Enter API Key'}</div>
      <div class="ob-desc">${msg('OB_STEP_APIKEY_DESC') || ''}</div>
      <input class="ob-key-input" id="ob-key" type="password" placeholder="Paste your key here..." value="${escHtml(apiKey)}" autocomplete="off" />
      <div class="ob-status" id="ob-test-status"></div>
      <div class="ob-actions">
        <button class="ob-btn ob-btn-ghost" id="ob-skip">${msg('OB_BTN_SKIP') || 'Skip'}</button>
        <button class="ob-btn ob-btn-primary" id="ob-test">${msg('OB_BTN_TEST') || 'Test Connection'}</button>
      </div>`;
  }

  function renderTabsStep() {
    const ready = tabCount >= 3;
    const counterClass = ready ? 'ob-tab-counter ready' : 'ob-tab-counter';
    const suffix = tabCount !== 1 ? 's' : '';
    const label = msg('OB_TABS_INDEXED', [String(tabCount), suffix]) || `${tabCount} tab${suffix} indexed`;
    const hint = ready ? '' : (msg('OB_TABS_GOAL') || 'Open 3+ tabs to continue');

    return `
      <div class="ob-icon">\u{1F4C4}</div>
      <div class="ob-title">${msg('OB_STEP_TABS') || 'Browse Some Tabs'}</div>
      <div class="ob-desc">${msg('OB_STEP_TABS_DESC') || ''}</div>
      <div class="${counterClass}">${tabCount}</div>
      <div class="ob-tab-hint">${label}${hint ? ' \u2014 ' + hint : ''}</div>
      <div class="ob-actions">
        <button class="ob-btn ob-btn-ghost" id="ob-skip">${msg('OB_BTN_SKIP') || 'Skip'}</button>
        <button class="ob-btn ob-btn-primary" id="ob-next" ${ready ? '' : 'disabled'}>${msg('OB_BTN_NEXT') || 'Next'}</button>
      </div>`;
  }

  function renderDoneStep() {
    return `
      <div class="ob-success-icon">\u2705</div>
      <div class="ob-title">${msg('OB_STEP_DONE') || "You're All Set!"}</div>
      <div class="ob-desc">${msg('OB_STEP_DONE_DESC') || ''}</div>
      <div class="ob-actions">
        <button class="ob-btn ob-btn-primary" id="ob-done">${msg('OB_BTN_DONE') || 'Start Chatting'}</button>
      </div>`;
  }

  function bindStepEvents() {
    overlay.querySelector('#ob-skip')?.addEventListener('click', finish);
    overlay.querySelector('#ob-done')?.addEventListener('click', finish);

    overlay.querySelector('#ob-next')?.addEventListener('click', () => {
      step++;
      if (step === 2) startTabPolling();
      render();
    });

    overlay.querySelectorAll('.ob-provider-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedProvider = btn.dataset.pid;
        render();
      });
    });

    const keyInput = overlay.querySelector('#ob-key');
    if (keyInput) {
      keyInput.addEventListener('input', () => { apiKey = keyInput.value.trim(); });
      keyInput.focus();
    }

    overlay.querySelector('#ob-test')?.addEventListener('click', testConnection);
  }

  async function testConnection() {
    const statusEl = overlay.querySelector('#ob-test-status');
    if (!apiKey) {
      if (statusEl) { statusEl.className = 'ob-status err'; statusEl.textContent = msg('OB_TEST_FAIL') || 'Enter a key'; }
      return;
    }

    if (statusEl) { statusEl.className = 'ob-status info'; statusEl.textContent = msg('OB_TESTING') || 'Testing...'; }
    const testBtn = overlay.querySelector('#ob-test');
    if (testBtn) testBtn.disabled = true;

    const model = PROVIDER_MODELS[selectedProvider]?.[0] || '';
    await chrome.storage.local.set({ provider: selectedProvider, apiKey, model });

    try {
      const result = await _testViaPort();
      if (result.ok) {
        testPassed = true;
        if (statusEl) { statusEl.className = 'ob-status ok'; statusEl.textContent = msg('OB_TEST_OK') || 'Success!'; }
        setTimeout(() => { step++; startTabPolling(); render(); }, 800);
      } else {
        if (statusEl) { statusEl.className = 'ob-status err'; statusEl.textContent = msg('OB_TEST_FAIL') || 'Failed'; }
        if (testBtn) testBtn.disabled = false;
      }
    } catch (err) {
      if (statusEl) { statusEl.className = 'ob-status err'; statusEl.textContent = (msg('OB_TEST_FAIL') || 'Failed') + ' ' + err.message; }
      if (testBtn) testBtn.disabled = false;
    }
  }

  function _testViaPort() {
    return new Promise((resolve, reject) => {
      const p = chrome.runtime.connect({ name: 'omni-chat' });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        p.disconnect();
        reject(new Error('Timeout'));
      }, 12000);

      p.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(chrome.runtime.lastError?.message || 'Disconnected'));
      });

      p.onMessage.addListener((m) => {
        if (m.type === 'TEST_RESULT') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          p.disconnect();
          resolve(m);
        }
      });

      p.postMessage({ type: 'TEST_CONNECTION' });
    });
  }

  function startTabPolling() {
    if (port) return;
    port = chrome.runtime.connect({ name: 'omni-chat' });
    port.onMessage.addListener((m) => {
      if (m.type === 'TAB_COUNT' && m.count !== tabCount) {
        tabCount = m.count || 0;
        if (step === 2) render();
      }
    });
    port.postMessage({ type: 'GET_TAB_COUNT' });
  }

  function finish() {
    if (port) { try { port.disconnect(); } catch (_) {} port = null; }
    markOnboardingDone();
    overlay.remove();
    if (onComplete) onComplete();
  }

  render();
}
