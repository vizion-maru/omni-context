import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _store } from './chrome-mock.js';
import { errorLogger } from '../extension/lib/error-logger.js';

describe('errorLogger', () => {
  beforeEach(async () => {
    await errorLogger.clear();
  });

  describe('log', () => {
    it('adds an entry with timestamp, source, and message', () => {
      errorLogger.log('test:source', 'something broke');
      const entries = errorLogger.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe('test:source');
      expect(entries[0].message).toBe('something broke');
      expect(entries[0].timestamp).toBeTypeOf('number');
    });

    it('extracts message from Error objects', () => {
      errorLogger.log('module:fn', new Error('oops'));
      const entries = errorLogger.getAll();
      expect(entries[0].message).toBe('oops');
      expect(entries[0].stack).toContain('oops');
    });

    it('uses "unknown" as source when empty string is passed', () => {
      errorLogger.log('', 'msg');
      const entries = errorLogger.getAll();
      expect(entries[0].source).toBe('unknown');
    });

    it('converts non-Error values to string', () => {
      errorLogger.log('src', 42);
      expect(errorLogger.getAll()[0].message).toBe('42');
    });
  });

  describe('getAll', () => {
    it('returns entries in chronological order', () => {
      errorLogger.log('a', 'first');
      errorLogger.log('b', 'second');
      errorLogger.log('c', 'third');
      const entries = errorLogger.getAll();
      expect(entries.map(e => e.message)).toEqual(['first', 'second', 'third']);
    });

    it('returns a copy — mutations do not affect buffer', () => {
      errorLogger.log('x', 'data');
      const copy = errorLogger.getAll();
      copy.length = 0;
      expect(errorLogger.getAll()).toHaveLength(1);
    });
  });

  describe('ring buffer overflow', () => {
    it('caps at 100 entries, removing oldest first', () => {
      for (let i = 0; i < 120; i++) {
        errorLogger.log('bulk', `entry-${i}`);
      }
      const entries = errorLogger.getAll();
      expect(entries).toHaveLength(100);
      expect(entries[0].message).toBe('entry-20');
      expect(entries[99].message).toBe('entry-119');
    });
  });

  describe('clear', () => {
    it('removes all entries from buffer', async () => {
      errorLogger.log('src', 'data');
      await errorLogger.clear();
      expect(errorLogger.getAll()).toHaveLength(0);
    });

    it('removes persisted data from chrome.storage.local', async () => {
      _store.errorLog = [{ source: 'old', message: 'stale', timestamp: 1 }];
      await errorLogger.clear();
      expect(_store.errorLog).toBeUndefined();
    });
  });

  describe('persist and load', () => {
    it('round-trips buffer through chrome.storage.local', async () => {
      errorLogger.log('src1', 'msg1');
      errorLogger.log('src2', 'msg2');
      await errorLogger.persist();

      expect(_store.errorLog).toHaveLength(2);
      expect(_store.errorLog[0].source).toBe('src1');
    });

    it('load restores entries from storage', async () => {
      _store.errorLog = [
        { timestamp: 100, source: 'stored', message: 'from-disk' },
        { timestamp: 200, source: 'stored', message: 'second' },
      ];

      await errorLogger.load();
      const entries = errorLogger.getAll();
      expect(entries).toHaveLength(2);
      expect(entries[0].message).toBe('from-disk');
      expect(entries[1].message).toBe('second');
    });

    it('load truncates to MAX_ENTRIES if storage has more', async () => {
      _store.errorLog = Array.from({ length: 150 }, (_, i) => ({
        timestamp: i,
        source: 'bulk',
        message: `m-${i}`,
      }));

      await errorLogger.load();
      const entries = errorLogger.getAll();
      expect(entries).toHaveLength(100);
      expect(entries[0].message).toBe('m-50');
    });

    it('load keeps existing buffer when storage is empty', async () => {
      errorLogger.log('x', 'pre-existing');
      await errorLogger.load();
      expect(errorLogger.getAll()).toHaveLength(1);
    });
  });

  describe('getCategories', () => {
    it('groups entries by source prefix', () => {
      errorLogger.log('background:init', 'err1');
      errorLogger.log('background:chat', 'err2');
      errorLogger.log('sync:push', 'err3');

      const cats = errorLogger.getCategories();
      expect(cats).toEqual({ background: 2, sync: 1 });
    });

    it('returns empty object when buffer is empty', () => {
      expect(errorLogger.getCategories()).toEqual({});
    });
  });
});
