/**
 * In-memory tab content indexer with keyword-based relevance scoring.
 * No external dependencies, no persistence — lives in the service worker.
 */

import { sanitizeText, truncateToTokens } from './utils.js';
import { errorLogger } from './error-logger.js';
import { cosineSimilarity } from './embeddings.js';

const MAX_CONTENT_CHARS = 20000;
const MAX_CONTEXT_CHARS_TOTAL = 50000;
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
    this._coherenceCache = null;
    /** @type {number} Count of entries that have a non-null embedding vector. */
    this._embeddingCount = 0;
  }

  /**
   * Add or update a tab's content in the index.
   * Sanitizes and truncates content, extracts keywords, and deduplicates by normalized URL.
   * @param {number} tabId  Chrome tab ID to index.
   * @param {{title: string, url: string, content: string}} data  Page data to store.
   */
  upsert(tabId, { title, url, content }) {
    const clean = sanitizeText(content || '').slice(0, MAX_CONTENT_CHARS);
    const normalizedUrl = this._normalizeUrl(url || '');
    const now = Date.now();
    const existing = this._index.get(tabId);
    const contentChanged = !existing || existing.content !== clean;
    const entry = {
      tabId,
      title: sanitizeText(title || '').slice(0, 200),
      url: (url || '').slice(0, 500),
      content: clean,
      keywords: this._extractKeywords(clean + ' ' + title),
      embedding: contentChanged ? null : (existing?.embedding || null),
      timestamp: now,
      firstIndexed: existing ? existing.firstIndexed : now,
      lastContentChange: contentChanged ? now : (existing ? existing.lastContentChange : now),
      lastReferenced: existing ? existing.lastReferenced : 0
    };
    // Maintain _embeddingCount: if content changed, old embedding is dropped
    if (existing?.embedding != null && contentChanged) this._embeddingCount--;
    if (normalizedUrl) {
      for (const [existingId, dup] of this._index) {
        if (existingId !== tabId && this._normalizeUrl(dup.url) === normalizedUrl) {
          if (dup.embedding != null) this._embeddingCount--;
          this._index.delete(existingId);
          break;
        }
      }
    }
    this._index.set(tabId, entry);
    this._coherenceCache = null;
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
    } catch (err) {
      errorLogger.log('indexer:normalizeUrl', err);
      return url;
    }
  }

  /**
   * Remove a tab from the index by its Chrome tab ID.
   * Invalidates the coherence cache if the tab existed.
   * @param {number} tabId  Chrome tab ID to remove.
   */
  remove(tabId) {
    const entry = this._index.get(tabId);
    if (entry) {
      if (entry.embedding != null) this._embeddingCount--;
      this._index.delete(tabId);
      this._coherenceCache = null;
    }
  }

  /**
   * Mark tabs as recently referenced (used in a query).
   * @param {Iterable<number>} tabIds  Tab IDs that were included in the AI context.
   */
  markReferenced(tabIds) {
    const now = Date.now();
    for (const id of tabIds) {
      const entry = this._index.get(id);
      if (entry) entry.lastReferenced = now;
    }
  }

  /**
   * Return activity timeline data for all indexed tabs, sorted by most recent activity.
   * @returns {Array<{tabId: number, title: string, url: string, firstIndexed: number, lastContentChange: number, lastReferenced: number}>}
   */
  getTimeline() {
    const result = [];
    for (const entry of this._index.values()) {
      result.push({
        tabId: entry.tabId,
        title: entry.title,
        url: entry.url,
        firstIndexed: entry.firstIndexed || entry.timestamp,
        lastContentChange: entry.lastContentChange || entry.timestamp,
        lastReferenced: entry.lastReferenced || 0
      });
    }
    result.sort((a, b) => {
      const aLatest = Math.max(a.lastContentChange, a.lastReferenced);
      const bLatest = Math.max(b.lastContentChange, b.lastReferenced);
      return bLatest - aLatest;
    });
    return result;
  }

  /**
   * Set the embedding vector for a tab entry.
   * Maintains the _embeddingCount for O(1) _hasEmbeddings() checks.
   * @param {number} tabId
   * @param {Float32Array|null} embedding
   */
  setEmbedding(tabId, embedding) {
    const entry = this._index.get(tabId);
    if (!entry) return;
    const hadEmbedding = entry.embedding != null;
    const hasEmbedding = embedding != null;
    entry.embedding = embedding;
    if (!hadEmbedding && hasEmbedding) this._embeddingCount++;
    else if (hadEmbedding && !hasEmbedding) this._embeddingCount--;
  }

  /**
   * Return top relevant tabs for a given query string.
   * Uses embedding-based cosine similarity when a query embedding is provided,
   * falling back to keyword matching otherwise.
   * Returns array of {tabId, title, url, content, score} sorted by relevance descending.
   * @param {string} query  User's natural-language query to match against indexed content.
   * @param {number|null} [excludeTabId=null]  Tab ID to exclude from results (typically the active tab).
   * @param {Set<number>|null} [pinnedTabIds=null]  Tab IDs that are always included.
   * @param {Float32Array|null} [queryEmbedding=null]  Pre-computed embedding of the query for semantic matching.
   * @returns {Array<{tabId: number, title: string, url: string, content: string, keywords: Set<string>, score: number}>}
   *   Top matching tabs (up to MAX_CONTEXT_TABS) sorted by relevance score descending.
   */
  getRelevantTabs(query, excludeTabId = null, pinnedTabIds = null, queryEmbedding = null) {
    if (queryEmbedding && this._hasEmbeddings()) {
      return this._getRelevantTabsWithEmbeddings(queryEmbedding, excludeTabId, pinnedTabIds, query);
    }
    const queryKeywords = this._extractKeywords(query);
    return this._getRelevantTabsWithKeywords(queryKeywords, excludeTabId, pinnedTabIds);
  }

  /**
   * Internal: return top relevant tabs using pre-computed query keywords.
   * Avoids redundant _extractKeywords calls when callers already have keywords.
   * @param {Set<string>} queryKeywords  Pre-extracted keywords from the query.
   * @param {number|null} excludeTabId  Tab ID to skip.
   * @returns {Array} Scored tabs sorted by relevance descending.
   */
  _getRelevantTabsWithKeywords(queryKeywords, excludeTabId, pinnedTabIds = null) {
    if (queryKeywords.size === 0) {
      return this._recentTabs(excludeTabId);
    }

    const pinned = [];
    const scored = [];
    for (const [tabId, entry] of this._index) {
      if (tabId === excludeTabId) continue;
      const score = this._score(queryKeywords, entry);
      const isPinned = pinnedTabIds && pinnedTabIds.has(tabId);
      if (isPinned) {
        pinned.push({ ...entry, score: Math.max(score, 0.01) });
      } else if (score > 0) {
        scored.push({ ...entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const remaining = Math.max(0, MAX_CONTEXT_TABS - pinned.length);
    const result = [...pinned, ...scored.slice(0, remaining)];
    result.sort((a, b) => b.score - a.score);
    return result;
  }

  /**
   * Return ALL tabs with their relevance scores (including score=0 ones).
   * Used for the tab relevance panel in the UI.
   * @param {string} query  User's query to score tabs against.
   * @param {number|null} [excludeTabId=null]  Tab ID to exclude from results.
   * @returns {Array<{tabId: number, title: string, url: string, score: number}>}
   *   All indexed tabs with scores, sorted by relevance descending.
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
   * Selects top-scoring tabs and concatenates their content, respecting token/char limits.
   * Uses embedding-based semantic search when a query embedding is provided, otherwise
   * falls back to keyword matching.
   * @param {string} query  User's query to determine relevance.
   * @param {number|null} [excludeTabId=null]  Tab ID to exclude (typically the active tab).
   * @param {Set<number>|null} [pinnedTabIds=null]  Tab IDs that are always included regardless of score.
   * @param {Float32Array|null} [queryEmbedding=null]  Pre-computed embedding vector for semantic matching.
   * @returns {string|null} Formatted context string with tab separators, or null if no tabs match.
   */
  buildContextString(query, excludeTabId = null, pinnedTabIds = null, queryEmbedding = null) {
    let tabs;
    if (queryEmbedding && this._hasEmbeddings()) {
      tabs = this._getRelevantTabsWithEmbeddings(queryEmbedding, excludeTabId, pinnedTabIds, query);
    } else {
      const queryKeywords = this._extractKeywords(query);
      tabs = this._getRelevantTabsWithKeywords(queryKeywords, excludeTabId, pinnedTabIds);
    }
    if (tabs.length === 0) return null;

    const parts = [];
    let totalChars = 0;

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const excerpt = truncateToTokens(tab.content || tab.title, MAX_CONTEXT_TOKENS_PER_TAB);
      const part = `[Tab ${i + 1}] ${tab.title}\nURL: ${tab.url}\n${excerpt}`;
      if (totalChars + part.length > MAX_CONTEXT_CHARS_TOTAL && parts.length > 0) break;
      parts.push(part);
      totalChars += part.length;
    }

    let result = parts.join('\n\n---\n\n');
    if (parts.length < tabs.length) {
      result += `\n\n[Context limited to top ${parts.length} of ${tabs.length} relevant tabs]`;
    }
    return result;
  }

  /**
   * Get source attribution info (for display in sidepanel).
   * Includes tabId for navigation on chip-click.
   * @param {string} query  User's query to determine which tabs are relevant sources.
   * @param {number|null} [excludeTabId=null]  Tab ID to exclude from attribution.
   * @returns {Array<{tabId: number, title: string, url: string, score: number}>}
   *   Source tabs with relevance scores for UI display.
   */
  getSourceAttribution(query, excludeTabId = null, pinnedTabIds = null) {
    const queryKeywords = this._extractKeywords(query);
    return this._getRelevantTabsWithKeywords(queryKeywords, excludeTabId, pinnedTabIds).map(tab => ({
      tabId: tab.tabId,
      title: tab.title,
      url: tab.url,
      score: tab.score
    }));
  }

  /**
   * Compute coherence score across all indexed tabs.
   * Uses Jaccard similarity between keyword sets to measure how related tabs are.
   * Caches the result until the index changes.
   * @returns {{score: number, topic: string, outliers: number[]}}
   *   score: 0-100 coherence percentage, topic: top shared keywords (comma-separated),
   *   outliers: tab IDs that are significantly less related to the group.
   */
  getCoherenceScore() {
    if (this._coherenceCache !== null) return this._coherenceCache;

    const entries = [...this._index.values()];

    if (entries.length === 0) {
      this._coherenceCache = { score: 100, topic: '', outliers: [] };
      return this._coherenceCache;
    }
    if (entries.length === 1) {
      const words = [...entries[0].keywords].slice(0, 3).join(', ');
      this._coherenceCache = { score: 100, topic: words, outliers: [] };
      return this._coherenceCache;
    }

    // For >20 tabs, sample ~20 representative tabs to limit O(n²) to O(400)
    const SAMPLE_THRESHOLD = 20;
    const sample = entries.length > SAMPLE_THRESHOLD
      ? this._sampleEntries(entries, SAMPLE_THRESHOLD)
      : entries;

    // Compute per-tab average Jaccard similarity with all others in sample
    const tabSims = new Map();
    for (let i = 0; i < sample.length; i++) {
      let totalSim = 0;
      for (let j = 0; j < sample.length; j++) {
        if (i === j) continue;
        totalSim += this._jaccard(sample[i].keywords, sample[j].keywords);
      }
      tabSims.set(sample[i].tabId, totalSim / (sample.length - 1));
    }

    const simValues = [...tabSims.values()];
    const mean = simValues.reduce((a, b) => a + b, 0) / simValues.length;

    // Variance and std dev to find outliers
    const variance = simValues.reduce((acc, s) => acc + (s - mean) ** 2, 0) / simValues.length;
    const stddev = Math.sqrt(variance);
    const outlierThreshold = Math.max(0, mean - stddev);

    const outliers = sample
      .filter(e => tabSims.get(e.tabId) < outlierThreshold)
      .map(e => e.tabId);

    // Detect topic: most frequent keywords weighted by count (use all entries)
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

    this._coherenceCache = {
      score: Math.round(mean * 100),
      topic: topWords.join(', '),
      outliers
    };
    return this._coherenceCache;
  }

  /**
   * Get the number of tabs currently stored in the index.
   * @returns {number} Count of indexed tab entries.
   */
  size() {
    return this._index.size;
  }

  /**
   * Persist the in-memory index to chrome.storage.local for survival across
   * service worker restarts. Serializes keyword Sets to arrays for JSON storage.
   * On quota exceeded, evicts oldest 20% of entries and retries once.
   * @returns {Promise<void>}
   */
  async persist() {
    try {
      const serialized = {};
      for (const [tabId, entry] of this._index) {
        serialized[tabId] = {
          ...entry,
          keywords: [...entry.keywords],
          embedding: entry.embedding ? Array.from(entry.embedding) : null
        };
      }
      await chrome.storage.local.set({ '_tabIndex_v1': serialized });
    } catch (err) {
      if (Indexer.isQuotaError(err)) {
        const evicted = this._evictOldest();
        errorLogger.log('indexer:persist:quotaEviction', `evicted ${evicted} entries, retrying`);
        try {
          const serialized = {};
          for (const [tabId, entry] of this._index) {
            serialized[tabId] = { ...entry, keywords: [...entry.keywords], embedding: entry.embedding ? Array.from(entry.embedding) : null };
          }
          await chrome.storage.local.set({ '_tabIndex_v1': serialized });
        } catch (retryErr) {
          errorLogger.log('indexer:persist:retryFailed', retryErr);
          if (Indexer.isQuotaError(retryErr)) throw retryErr;
        }
        return;
      }
      errorLogger.log('indexer:persist', err);
    }
  }

  /**
   * Persist only the specified dirty tab entries. Falls back to full persist
   * (with eviction) on quota error, or when dirty count exceeds 50% of total.
   * @param {Set<number>} dirtyTabIds  Tab IDs that changed since last persist.
   * @returns {Promise<void>}
   */
  async persistDirty(dirtyTabIds) {
    if (dirtyTabIds.size === 0) return;

    if (dirtyTabIds.size > this._index.size * 0.5) {
      return this.persist();
    }

    try {
      const result = await chrome.storage.local.get('_tabIndex_v1');
      const stored = result['_tabIndex_v1'] || {};

      for (const tabId of dirtyTabIds) {
        const entry = this._index.get(tabId);
        if (entry) {
          stored[tabId] = { ...entry, keywords: [...entry.keywords], embedding: entry.embedding ? Array.from(entry.embedding) : null };
        } else {
          delete stored[tabId];
        }
      }

      await chrome.storage.local.set({ '_tabIndex_v1': stored });
    } catch (err) {
      if (Indexer.isQuotaError(err)) {
        errorLogger.log('indexer:persistDirty:quotaFallback', 'falling back to full persist with eviction');
        return this.persist();
      }
      errorLogger.log('indexer:persistDirty', err);
      throw err;
    }
  }

  /**
   * Check whether an error is a storage quota exceeded error.
   * @param {Error} err
   * @returns {boolean}
   */
  static isQuotaError(err) {
    if (!err) return false;
    return err.name === 'QuotaExceededError' ||
      (typeof err.message === 'string' && err.message.includes('QUOTA_BYTES'));
  }

  /**
   * Restore the index from chrome.storage.local on service worker startup.
   * Deserializes keyword arrays back into Sets. Silently skips if no persisted
   * data exists or if the read fails.
   * @returns {Promise<void>}
   */
  async restore() {
    try {
      const result = await chrome.storage.local.get('_tabIndex_v1');
      const data = result['_tabIndex_v1'];
      if (!data || typeof data !== 'object') return;
      let embCount = 0;
      for (const [tabId, entry] of Object.entries(data)) {
        const emb = entry.embedding ? new Float32Array(entry.embedding) : null;
        if (emb) embCount++;
        this._index.set(Number(tabId), {
          ...entry,
          tabId: Number(entry.tabId),
          keywords: new Set(entry.keywords),
          embedding: emb,
          firstIndexed: entry.firstIndexed || entry.timestamp || Date.now(),
          lastContentChange: entry.lastContentChange || entry.timestamp || Date.now(),
          lastReferenced: entry.lastReferenced || 0
        });
      }
      this._embeddingCount = embCount;
    } catch (err) {
      errorLogger.log('indexer:restore', err);
    }
  }

  /**
   * Reconcile the index with currently open Chrome tabs — removes entries
   * for tabs that no longer exist. Should be called after restore() to prune
   * stale entries from tabs closed while the service worker was inactive.
   * @returns {Promise<void>}
   */
  async reconcile() {
    try {
      const tabs = await chrome.tabs.query({});
      const liveIds = new Set(tabs.map(t => t.id));
      let removed = false;
      for (const tabId of this._index.keys()) {
        if (!liveIds.has(tabId)) {
          const entry = this._index.get(tabId);
          if (entry?.embedding != null) this._embeddingCount--;
          this._index.delete(tabId);
          removed = true;
        }
      }
      if (removed) this._coherenceCache = null;
    } catch (err) {
      errorLogger.log('indexer:reconcile', err);
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Evict the oldest 20% of entries by timestamp to free storage quota.
   * @returns {number} Number of entries evicted.
   */
  _evictOldest() {
    const entries = [...this._index.entries()];
    if (entries.length === 0) return 0;

    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const evictCount = Math.max(1, Math.ceil(entries.length * 0.2));

    for (let i = 0; i < evictCount; i++) {
      if (entries[i][1].embedding != null) this._embeddingCount--;
      this._index.delete(entries[i][0]);
    }
    this._coherenceCache = null;
    return evictCount;
  }

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
   * Caches the lowercased title outside the iteration loop to avoid O(n) repeated
   * string allocations where n = queryKeywords.size.
   * @param {Set<string>} queryKeywords  Keywords extracted from the user's query.
   * @param {{title: string, keywords: Set<string>}} entry  Indexed tab entry.
   * @returns {number} Relevance score between 0 and 1.
   */
  _score(queryKeywords, entry) {
    if (queryKeywords.size === 0) return 0;

    // Cache lowercased title outside the loop to avoid repeated allocations.
    // For N keywords × M tabs, this reduces toLowerCase() calls from N×M to M.
    const titleLower = entry.title.toLowerCase();
    let weightedHits = 0;
    for (const kw of queryKeywords) {
      if (titleLower.includes(kw)) {
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
   * Check whether enough indexed entries have embeddings to use semantic search.
   * Uses the maintained _embeddingCount for O(1) performance instead of
   * iterating all entries on every query.
   * @returns {boolean} True if at least 30% of indexed entries have embeddings.
   */
  _hasEmbeddings() {
    if (this._index.size === 0) return false;
    return this._embeddingCount / this._index.size >= 0.3;
  }

  /**
   * Score and rank tabs using cosine similarity between query embedding and stored embeddings.
   * Falls back to keyword scoring for entries without embeddings.
   * Pinned tabs are always included with a minimum score of 0.01.
   * @param {Float32Array} queryEmbedding  Pre-computed embedding vector for the user's query.
   * @param {number|null} excludeTabId  Tab ID to skip (typically the active tab).
   * @param {Set<number>|null} pinnedTabIds  Tab IDs that are always included regardless of score.
   * @param {string} query  Raw query string used as keyword fallback for entries without embeddings.
   * @returns {Array<{tabId: number, title: string, url: string, content: string, keywords: Set<string>, embedding: Float32Array|null, score: number}>}
   *   Top matching tabs (up to MAX_CONTEXT_TABS) sorted by relevance score descending.
   * @private
   */
  _getRelevantTabsWithEmbeddings(queryEmbedding, excludeTabId, pinnedTabIds, query) {
    const queryKeywords = this._extractKeywords(query);
    const pinned = [];
    const scored = [];

    for (const [tabId, entry] of this._index) {
      if (tabId === excludeTabId) continue;

      let score;
      if (entry.embedding) {
        score = Math.max(0, cosineSimilarity(queryEmbedding, entry.embedding));
      } else {
        score = this._score(queryKeywords, entry);
      }

      const isPinned = pinnedTabIds && pinnedTabIds.has(tabId);
      if (isPinned) {
        pinned.push({ ...entry, score: Math.max(score, 0.01) });
      } else if (score > 0) {
        scored.push({ ...entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const remaining = Math.max(0, MAX_CONTEXT_TABS - pinned.length);
    const result = [...pinned, ...scored.slice(0, remaining)];
    result.sort((a, b) => b.score - a.score);
    return result;
  }

  /**
   * Select a random sample of entries using Fisher-Yates partial shuffle.
   * @param {Array} entries  Full array of index entries.
   * @param {number} n  Number of entries to sample.
   * @returns {Array} Random subset of n entries.
   */
  _sampleEntries(entries, n) {
    const copy = entries.slice();
    for (let i = copy.length - 1; i > copy.length - 1 - n && i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(copy.length - n);
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
