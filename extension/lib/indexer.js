/**
 * In-memory tab content indexer with keyword-based relevance scoring.
 * No external dependencies, no persistence — lives in the service worker.
 */

import { sanitizeText, truncateToTokens } from './utils.js';

const MAX_CONTENT_CHARS = 8000;
const MAX_CONTEXT_CHARS_TOTAL = 20000;
const MAX_CONTEXT_TABS = 8;
const MAX_CONTEXT_TOKENS_PER_TAB = 1200;

/**
 * Common stopwords (EN + DE) excluded from keyword extraction.
 * Hoisted to module scope to avoid re-creating the Set on every call.
 */
const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','being','have','has','had','do',
  'does','did','will','would','could','should','may','might','can','that',
  'this','these','those','it','its','i','you','he','she','we','they',
  'not','no','so','if','as','by','from','up','about','into','through',
  'also','just','more','some','what','which','who','how','when','where',
  'der','die','das','und','ist','ein','eine','für','mit','auf','den',
  'dem','des','von','zu','im','in','nicht','sich','auch','es','an',
  'als','aus','bei','hat','nach','noch','nur','über','wie','so','oder',
  'aber','vor','zum','zur','bis','durch','unter','ohne','zwischen',
  'diese','dieser','diesem','wird','kann','sein','seine','werden',
  'wenn','war','haben','sind','dass','er','sie','ich','wir','ihr','du'
]);

export class Indexer {
  constructor() {
    // Map<tabId, {tabId, title, url, content, keywords, timestamp}>
    this._index = new Map();
  }

  /**
   * Add or update a tab's content in the index.
   */
  upsert(tabId, { title, url, content }) {
    const clean = sanitizeText(content || '').slice(0, MAX_CONTENT_CHARS);
    const normalizedUrl = this._normalizeUrl(url || '');
    const entry = {
      tabId,
      title: sanitizeText(title || '').slice(0, 200),
      url: (url || '').slice(0, 500),
      content: clean,
      keywords: this._extractKeywords(clean + ' ' + title),
      timestamp: Date.now()
    };
    if (normalizedUrl) {
      for (const [existingId, existing] of this._index) {
        if (existingId !== tabId && this._normalizeUrl(existing.url) === normalizedUrl) {
          this._index.delete(existingId);
          break;
        }
      }
    }
    this._index.set(tabId, entry);
  }

  /**
   * Normalize a URL for deduplication — strips hash fragments and trailing slashes.
   * @param {string} url  Raw URL string to normalize.
   * @returns {string} Canonical URL without hash or trailing slash, or the original string on parse failure.
   */
  _normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      let path = u.pathname;
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      return u.origin + path + u.search;
    } catch (_) {
      return url;
    }
  }

  /**
   * Remove a tab from the index.
   */
  remove(tabId) {
    this._index.delete(tabId);
  }

  /**
   * Return top relevant tabs for a given query string.
   * Returns array of {tabId, title, url, content, score} sorted by relevance descending.
   */
  getRelevantTabs(query, excludeTabId = null) {
    const queryKeywords = this._extractKeywords(query);
    if (queryKeywords.size === 0) {
      return this._recentTabs(excludeTabId);
    }

    const scored = [];
    for (const [tabId, entry] of this._index) {
      if (tabId === excludeTabId) continue;
      const score = this._score(queryKeywords, entry);
      if (score > 0) {
        scored.push({ ...entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_CONTEXT_TABS);
  }

  /**
   * Return ALL tabs with their relevance scores (including score=0 ones).
   * Used for the tab relevance panel in the UI.
   */
  getAllScoredTabs(query, excludeTabId = null) {
    const queryKeywords = this._extractKeywords(query);
    const result = [];

    for (const [tabId, entry] of this._index) {
      if (tabId === excludeTabId) continue;
      const score = queryKeywords.size > 0 ? this._score(queryKeywords, entry) : 0;
      result.push({ tabId: entry.tabId, title: entry.title, url: entry.url, score });
    }

    return result.sort((a, b) => b.score - a.score);
  }

  /**
   * Build a context string for the AI prompt from relevant tabs.
   */
  buildContextString(query, excludeTabId = null) {
    const tabs = this.getRelevantTabs(query, excludeTabId);
    if (tabs.length === 0) return null;

    const parts = [];
    let totalChars = 0;
    let included = 0;

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const excerpt = truncateToTokens(tab.content || tab.title, MAX_CONTEXT_TOKENS_PER_TAB);
      const part = `[Tab ${i + 1}] ${tab.title}\nURL: ${tab.url}\n${excerpt}`;
      if (totalChars + part.length > MAX_CONTEXT_CHARS_TOTAL && parts.length > 0) break;
      parts.push(part);
      totalChars += part.length;
      included++;
    }

    let result = parts.join('\n\n---\n\n');
    if (included < tabs.length) {
      result += `\n\n[Context limited to top ${included} of ${tabs.length} relevant tabs]`;
    }
    return result;
  }

  /**
   * Get source attribution info (for display in sidepanel).
   * Includes tabId for navigation on chip-click.
   */
  getSourceAttribution(query, excludeTabId = null) {
    return this.getRelevantTabs(query, excludeTabId).map(tab => ({
      tabId: tab.tabId,
      title: tab.title,
      url: tab.url,
      score: tab.score
    }));
  }

  /**
   * Compute coherence score across all indexed tabs.
   * Returns { score: 0-100, topic: string, outliers: tabId[] }
   */
  getCoherenceScore() {
    const entries = [...this._index.values()];

    if (entries.length === 0) {
      return { score: 100, topic: '', outliers: [] };
    }
    if (entries.length === 1) {
      const words = [...entries[0].keywords].slice(0, 3).join(', ');
      return { score: 100, topic: words, outliers: [] };
    }

    // Compute per-tab average Jaccard similarity with all others
    const tabSims = new Map();
    for (let i = 0; i < entries.length; i++) {
      let totalSim = 0;
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        totalSim += this._jaccard(entries[i].keywords, entries[j].keywords);
      }
      tabSims.set(entries[i].tabId, totalSim / (entries.length - 1));
    }

    const simValues = [...tabSims.values()];
    const mean = simValues.reduce((a, b) => a + b, 0) / simValues.length;

    // Variance and std dev to find outliers
    const variance = simValues.reduce((acc, s) => acc + (s - mean) ** 2, 0) / simValues.length;
    const stddev = Math.sqrt(variance);
    const outlierThreshold = Math.max(0, mean - stddev);

    const outliers = entries
      .filter(e => tabSims.get(e.tabId) < outlierThreshold)
      .map(e => e.tabId);

    // Detect topic: most frequent keywords weighted by count
    const freqMap = new Map();
    for (const entry of entries) {
      for (const kw of entry.keywords) {
        freqMap.set(kw, (freqMap.get(kw) || 0) + 1);
      }
    }
    const topWords = [...freqMap.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([kw]) => kw);

    return {
      score: Math.round(mean * 100),
      topic: topWords.join(', '),
      outliers
    };
  }

  size() {
    return this._index.size;
  }

  async persist() {
    try {
      const serialized = {};
      for (const [tabId, entry] of this._index) {
        serialized[tabId] = {
          ...entry,
          keywords: [...entry.keywords]
        };
      }
      await chrome.storage.local.set({ '_tabIndex_v1': serialized });
    } catch (err) {
      console.warn('[Indexer] persist failed:', err);
    }
  }

  async restore() {
    try {
      const result = await chrome.storage.local.get('_tabIndex_v1');
      const data = result['_tabIndex_v1'];
      if (!data || typeof data !== 'object') return;
      for (const [tabId, entry] of Object.entries(data)) {
        this._index.set(Number(tabId), {
          ...entry,
          tabId: Number(entry.tabId),
          keywords: new Set(entry.keywords)
        });
      }
    } catch (err) {
      console.warn('[Indexer] restore failed:', err);
    }
  }

  async reconcile() {
    try {
      const tabs = await chrome.tabs.query({});
      const liveIds = new Set(tabs.map(t => t.id));
      for (const tabId of this._index.keys()) {
        if (!liveIds.has(tabId)) this._index.delete(tabId);
      }
    } catch (err) {
      console.warn('[Indexer] reconcile failed:', err);
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Extract unique keywords from text for relevance matching.
   * Filters out stopwords and short tokens (< 3 chars).
   * @param {string} text  Raw text to extract keywords from.
   * @returns {Set<string>} Lowercase keyword set.
   */
  _extractKeywords(text) {
    if (!text) return new Set();

    return new Set(
      text.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOPWORDS.has(w))
    );
  }

  /**
   * Score an index entry against query keywords using weighted title/content matching.
   * Title matches score 3x higher than content keyword matches.
   * @param {Set<string>} queryKeywords  Keywords extracted from the user's query.
   * @param {{title: string, keywords: Set<string>}} entry  Indexed tab entry.
   * @returns {number} Relevance score between 0 and 1.
   */
  _score(queryKeywords, entry) {
    if (queryKeywords.size === 0) return 0;

    let weightedHits = 0;
    for (const kw of queryKeywords) {
      if (entry.title.toLowerCase().includes(kw)) {
        weightedHits += 3;
      } else if (entry.keywords.has(kw)) {
        weightedHits += 1;
      }
    }

    if (weightedHits === 0) return 0;
    return weightedHits / (queryKeywords.size * 3);
  }

  /**
   * Compute Jaccard similarity coefficient between two sets.
   * @param {Set<string>} setA  First keyword set.
   * @param {Set<string>} setB  Second keyword set.
   * @returns {number} Similarity between 0 (disjoint) and 1 (identical).
   */
  _jaccard(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Return the most recently indexed tabs when no query keywords are available.
   * @param {number|null} excludeTabId  Tab ID to skip (typically the active tab).
   * @returns {Array<{tabId: number, title: string, url: string, content: string, score: number}>}
   */
  _recentTabs(excludeTabId) {
    const tabs = [];
    for (const [tabId, entry] of this._index) {
      if (tabId !== excludeTabId) tabs.push(entry);
    }
    tabs.sort((a, b) => b.timestamp - a.timestamp);
    return tabs.slice(0, MAX_CONTEXT_TABS).map(t => ({ ...t, score: 0 }));
  }
}
