import { describe, it, expect, beforeEach } from 'vitest';
import { Indexer } from '../extension/lib/indexer.js';

describe('Indexer', () => {
  let indexer;

  beforeEach(() => {
    indexer = new Indexer();
  });

  describe('_extractKeywords', () => {
    it('extracts lowercase keywords from text, filtering short words', () => {
      const kw = indexer._extractKeywords('JavaScript Framework Testing');
      expect(kw).toContain('javascript');
      expect(kw).toContain('framework');
      expect(kw).toContain('testing');
    });

    it('filters stopwords (EN and DE)', () => {
      const kw = indexer._extractKeywords('the quick brown fox and der schnelle Fuchs');
      expect(kw).not.toContain('the');
      expect(kw).not.toContain('and');
      expect(kw).not.toContain('der');
      expect(kw).toContain('quick');
      expect(kw).toContain('brown');
      expect(kw).toContain('fox');
      expect(kw).toContain('schnelle');
      expect(kw).toContain('fuchs');
    });

    it('filters words shorter than 3 characters', () => {
      const kw = indexer._extractKeywords('AI is an ML tool ok');
      expect(kw).not.toContain('ai');
      expect(kw).not.toContain('is');
      expect(kw).not.toContain('an');
      expect(kw).not.toContain('ml');
      expect(kw).not.toContain('ok');
      expect(kw).toContain('tool');
    });

    it('returns empty set for empty/null input', () => {
      expect(indexer._extractKeywords('')).toEqual(new Set());
      expect(indexer._extractKeywords(null)).toEqual(new Set());
      expect(indexer._extractKeywords(undefined)).toEqual(new Set());
    });

    it('strips punctuation before extracting', () => {
      const kw = indexer._extractKeywords('hello-world, foo_bar! baz.');
      expect(kw).toContain('hello');
      expect(kw).toContain('world');
      expect(kw).toContain('foo');
      expect(kw).toContain('bar');
      expect(kw).toContain('baz');
    });
  });

  describe('_score', () => {
    it('returns 0 for empty query keywords', () => {
      const entry = { title: 'Test', keywords: new Set(['test']) };
      expect(indexer._score(new Set(), entry)).toBe(0);
    });

    it('scores title matches 3x higher than content keywords', () => {
      const entry = { title: 'JavaScript Guide', keywords: new Set(['javascript', 'guide', 'programming']) };
      const titleOnly = indexer._score(new Set(['javascript']), entry);
      const contentOnly = indexer._score(new Set(['programming']), entry);
      expect(titleOnly).toBe(1);
      expect(contentOnly).toBeCloseTo(1 / 3);
    });

    it('returns 0 when no keywords match', () => {
      const entry = { title: 'React Hooks', keywords: new Set(['react', 'hooks', 'state']) };
      expect(indexer._score(new Set(['python', 'django']), entry)).toBe(0);
    });

    it('combines title and content matches correctly', () => {
      const entry = { title: 'React Tutorial', keywords: new Set(['react', 'tutorial', 'hooks', 'state']) };
      const score = indexer._score(new Set(['react', 'hooks']), entry);
      // 'react' in title = 3, 'hooks' in keywords = 1 → 4 / (2 * 3) = 2/3
      expect(score).toBeCloseTo(4 / 6);
    });
  });

  describe('upsert / remove / size', () => {
    it('adds entries and reports correct size', () => {
      indexer.upsert(1, { title: 'Tab One', url: 'https://one.com', content: 'Hello world' });
      indexer.upsert(2, { title: 'Tab Two', url: 'https://two.com', content: 'Goodbye world' });
      expect(indexer.size()).toBe(2);
    });

    it('updates existing entry on same tabId', () => {
      indexer.upsert(1, { title: 'Old', url: 'https://one.com', content: 'old content' });
      indexer.upsert(1, { title: 'New', url: 'https://one.com', content: 'new content' });
      expect(indexer.size()).toBe(1);
    });

    it('deduplicates by normalized URL (different tabId, same URL)', () => {
      indexer.upsert(1, { title: 'Page A', url: 'https://example.com/page#section1', content: 'content a' });
      indexer.upsert(2, { title: 'Page B', url: 'https://example.com/page#section2', content: 'content b' });
      expect(indexer.size()).toBe(1);
      expect(indexer._index.has(2)).toBe(true);
      expect(indexer._index.has(1)).toBe(false);
    });

    it('removes entries by tabId', () => {
      indexer.upsert(1, { title: 'Tab', url: 'https://x.com', content: 'content' });
      indexer.remove(1);
      expect(indexer.size()).toBe(0);
    });
  });

  describe('getRelevantTabs', () => {
    beforeEach(() => {
      indexer.upsert(1, { title: 'JavaScript Tutorial', url: 'https://js.dev', content: 'Learn JavaScript programming with examples' });
      indexer.upsert(2, { title: 'Python Guide', url: 'https://py.org', content: 'Python programming language documentation' });
      indexer.upsert(3, { title: 'CSS Styling', url: 'https://css.dev', content: 'Cascading stylesheets for web design' });
    });

    it('returns tabs sorted by relevance score descending', () => {
      const results = indexer.getRelevantTabs('javascript programming');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('JavaScript Tutorial');
      for (let i = 1; i < results.length; i++) {
        expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
      }
    });

    it('excludes specified tabId from results', () => {
      const results = indexer.getRelevantTabs('javascript', 1);
      expect(results.every(t => t.tabId !== 1)).toBe(true);
    });

    it('returns recent tabs when query has no valid keywords', () => {
      const results = indexer.getRelevantTabs('');
      expect(results.length).toBe(3);
    });

    it('includes pinned tabs regardless of score', () => {
      const pinned = new Set([3]);
      const results = indexer.getRelevantTabs('javascript programming', null, pinned);
      expect(results.some(t => t.tabId === 3)).toBe(true);
    });
  });

  describe('getCoherenceScore', () => {
    it('returns 100 for empty index', () => {
      const result = indexer.getCoherenceScore();
      expect(result.score).toBe(100);
      expect(result.outliers).toEqual([]);
    });

    it('returns 100 for single tab', () => {
      indexer.upsert(1, { title: 'Solo Tab', url: 'https://solo.com', content: 'some content here' });
      const result = indexer.getCoherenceScore();
      expect(result.score).toBe(100);
    });

    it('returns higher score for related tabs', () => {
      indexer.upsert(1, { title: 'React Hooks', url: 'https://react.dev/hooks', content: 'React hooks are functions that let you use state' });
      indexer.upsert(2, { title: 'React State', url: 'https://react.dev/state', content: 'Managing state in React components with hooks' });
      const related = indexer.getCoherenceScore();

      const indexer2 = new Indexer();
      indexer2.upsert(1, { title: 'React Hooks', url: 'https://react.dev', content: 'React hooks state management' });
      indexer2.upsert(2, { title: 'Cooking Recipes', url: 'https://food.com', content: 'Baking sourdough bread recipe flour' });
      const unrelated = indexer2.getCoherenceScore();

      expect(related.score).toBeGreaterThan(unrelated.score);
    });

    it('caches result until index changes', () => {
      indexer.upsert(1, { title: 'Tab A', url: 'https://a.com', content: 'content alpha' });
      indexer.upsert(2, { title: 'Tab B', url: 'https://b.com', content: 'content beta' });
      const first = indexer.getCoherenceScore();
      const second = indexer.getCoherenceScore();
      expect(first).toBe(second);

      indexer.upsert(3, { title: 'Tab C', url: 'https://c.com', content: 'different gamma' });
      const third = indexer.getCoherenceScore();
      expect(third).not.toBe(first);
    });
  });

  describe('persist / restore', () => {
    it('round-trips index data through chrome.storage.local', async () => {
      indexer.upsert(1, { title: 'Persisted Tab', url: 'https://persist.com', content: 'persist me' });
      await indexer.persist();

      const restored = new Indexer();
      await restored.restore();
      expect(restored.size()).toBe(1);
      expect(restored._index.get(1).title).toBe('Persisted Tab');
      expect(restored._index.get(1).keywords).toBeInstanceOf(Set);
    });
  });

  describe('reconcile', () => {
    it('removes tabs not in chrome.tabs.query result', async () => {
      indexer.upsert(1, { title: 'Open', url: 'https://open.com', content: 'open' });
      indexer.upsert(2, { title: 'Closed', url: 'https://closed.com', content: 'closed' });
      chrome.tabs.query.mockResolvedValueOnce([{ id: 1 }]);

      await indexer.reconcile();
      expect(indexer.size()).toBe(1);
      expect(indexer._index.has(1)).toBe(true);
      expect(indexer._index.has(2)).toBe(false);
    });
  });

  describe('static isQuotaError', () => {
    it('detects QuotaExceededError by name', () => {
      const err = new Error('storage full');
      err.name = 'QuotaExceededError';
      expect(Indexer.isQuotaError(err)).toBe(true);
    });

    it('detects QUOTA_BYTES in message', () => {
      expect(Indexer.isQuotaError(new Error('QUOTA_BYTES quota exceeded'))).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(Indexer.isQuotaError(new Error('network failure'))).toBe(false);
      expect(Indexer.isQuotaError(null)).toBe(false);
    });
  });
});
