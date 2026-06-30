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
const PRO_STATUS_KEY = 'omni_pro_status';
const PRO_SOURCE_KEY = 'omni_pro_source';
const PRO_TRIAL_EXPIRES_AT_KEY = 'omni_pro_trial_expires_at';

class FeatureGate {
  static _pro = false;
  static _ready = false;
  static _listeners = [];

  /** Load pro status from storage. Call once in the service worker. */
  static async init() {
    try {
      const result = await chrome.storage.sync.get([
        PRO_STATUS_KEY,
        PRO_SOURCE_KEY,
        PRO_TRIAL_EXPIRES_AT_KEY,
      ]);
      FeatureGate._pro = FeatureGate._isStoredProActive(result);
      if (result[PRO_STATUS_KEY] === true && !FeatureGate._pro) {
        await FeatureGate.setPro(false);
      }
    } catch (err) {
      errorLogger.log('feature-gates:init', err);
      FeatureGate._pro = false;
    }
    FeatureGate._ready = true;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && (changes[PRO_STATUS_KEY] || changes[PRO_SOURCE_KEY] || changes[PRO_TRIAL_EXPIRES_AT_KEY])) {
        chrome.storage.sync.get([PRO_STATUS_KEY, PRO_SOURCE_KEY, PRO_TRIAL_EXPIRES_AT_KEY])
          .then((result) => {
            FeatureGate._pro = FeatureGate._isStoredProActive(result);
            FeatureGate._listeners.forEach(fn => fn(FeatureGate._pro));
          })
          .catch((err) => errorLogger.log('feature-gates:onChanged', err));
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
  /** @returns {boolean} Whether semantic search with embeddings is available (Pro only). */
  static canUseSemanticSearch() { return FeatureGate._pro; }
  /** @returns {boolean} Whether cross-device sync is available (Pro only). */
  static canUseSync()           { return FeatureGate._pro; }

  /**
   * Register a callback for pro status changes.
   * @param {function(boolean): void} fn  Callback receiving the new pro status.
   */
  static onChange(fn) { FeatureGate._listeners.push(fn); }

  /**
   * Programmatically set pro status (used by payment and trial callbacks).
   * Persists to chrome.storage.sync and updates the in-memory flag.
   *
   * @param {boolean} value  New pro status to set.
   * @param {{ source?: 'paid'|'trial'|'manual', trialExpiresAt?: string|null }} [metadata]
   * @returns {Promise<void>}
   */
  static async setPro(value, metadata = {}) {
    const v = value === true;
    const payload = { [PRO_STATUS_KEY]: v };

    if (!v) {
      payload[PRO_SOURCE_KEY] = null;
      payload[PRO_TRIAL_EXPIRES_AT_KEY] = null;
    } else {
      payload[PRO_SOURCE_KEY] = metadata.source || 'manual';
      payload[PRO_TRIAL_EXPIRES_AT_KEY] = metadata.trialExpiresAt || null;
    }

    await chrome.storage.sync.set(payload);
    FeatureGate._pro = FeatureGate._isStoredProActive(payload);
  }

  /**
   * Stored Pro is active when it is paid/manual, or when a trial has not expired.
   * Missing source preserves backward compatibility with older paid users whose
   * storage only contains omni_pro_status=true.
   * @param {Record<string, any>} result
   * @returns {boolean}
   */
  static _isStoredProActive(result) {
    if (result[PRO_STATUS_KEY] !== true) return false;
    const source = result[PRO_SOURCE_KEY];
    if (!source || source === 'paid' || source === 'manual') return true;
    if (source === 'trial') {
      const expiresAt = result[PRO_TRIAL_EXPIRES_AT_KEY];
      if (!expiresAt) return false;
      const expires = new Date(expiresAt).getTime();
      return !Number.isNaN(expires) && Date.now() < expires;
    }
    return false;
  }
}

export {
  FeatureGate,
  FREE_PROVIDERS,
  FREE_TAB_LIMIT,
  PRO_STATUS_KEY,
  PRO_SOURCE_KEY,
  PRO_TRIAL_EXPIRES_AT_KEY,
};
