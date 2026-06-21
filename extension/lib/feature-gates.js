/**
 * Omni-Context Feature Gates — Free vs Pro tier logic.
 *
 * Pro status is stored in chrome.storage.sync under 'omni_pro_status'.
 * Call FeatureGate.init() once at startup (background service worker).
 * Non-module scripts (sidepanel.js, options.js) read the flag directly
 * from storage and use the exported constants for provider/limit checks.
 */

import { errorLogger } from './error-logger.js';

const FREE_PROVIDERS = new Set(['openrouter', 'groq', 'gemini']);
const FREE_TAB_LIMIT = 10;

class FeatureGate {
  static _pro = false;
  static _ready = false;
  static _listeners = [];

  /** Load pro status from storage. Call once in the service worker. */
  static async init() {
    try {
      const result = await chrome.storage.sync.get('omni_pro_status');
      FeatureGate._pro = result.omni_pro_status === true;
    } catch (err) {
      errorLogger.log('feature-gates:init', err);
      FeatureGate._pro = false;
    }
    FeatureGate._ready = true;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.omni_pro_status) {
        FeatureGate._pro = changes.omni_pro_status.newValue === true;
        FeatureGate._listeners.forEach(fn => fn(FeatureGate._pro));
      }
    });
  }

  /** @returns {boolean} Whether the user has an active Pro subscription. */
  static get isPro() { return FeatureGate._pro; }

  /**
   * Check if a given provider is available for the current tier.
   * Free-tier users can only access providers in FREE_PROVIDERS.
   * @param {string} providerId  Provider identifier (e.g. 'openai', 'groq').
   * @returns {boolean} True if the provider is allowed for the current user.
   */
  static isProviderAllowed(providerId) {
    return FeatureGate._pro || FREE_PROVIDERS.has(providerId);
  }

  /**
   * Check if another tab can be added to the index under the current tier limit.
   * Free-tier users are limited to FREE_TAB_LIMIT indexed tabs.
   * @param {number} currentCount  Number of tabs currently in the index.
   * @returns {boolean} True if a new tab can be indexed.
   */
  static canIndexTab(currentCount) {
    return FeatureGate._pro || currentCount < FREE_TAB_LIMIT;
  }

  /** @returns {boolean} Whether conversation export is available (Pro only). */
  static canExport()            { return FeatureGate._pro; }
  /** @returns {boolean} Whether custom system prompts are available (Pro only). */
  static canUseCustomPrompts()  { return FeatureGate._pro; }
  /** @returns {boolean} Whether research mode (multi-step reasoning) is available (Pro only). */
  static canUseResearchMode()   { return FeatureGate._pro; }
  /** @returns {boolean} Whether filtering context by tab group is available (Pro only). */
  static canFilterByTabGroup()  { return FeatureGate._pro; }

  /**
   * Register a callback for pro status changes.
   * @param {function(boolean): void} fn  Callback receiving the new pro status.
   */
  static onChange(fn) { FeatureGate._listeners.push(fn); }

  /**
   * Programmatically set pro status (used by payment callback).
   * Persists to chrome.storage.sync and updates the in-memory flag.
   * @param {boolean} value  New pro status to set.
   * @returns {Promise<void>}
   */
  static async setPro(value) {
    const v = value === true;
    await chrome.storage.sync.set({ omni_pro_status: v });
    FeatureGate._pro = v;
  }
}

export { FeatureGate, FREE_PROVIDERS, FREE_TAB_LIMIT };
