// ── Index entry types ─────────────────────────────────────────────────────────

export interface IndexEntry {
  tabId: number;
  title: string;
  url: string;
  content: string;
  keywords: Set<string>;
  timestamp: number;
  firstIndexed: number;
  lastContentChange: number;
  lastReferenced: number;
}

export interface SerializedIndexEntry {
  tabId: number;
  title: string;
  url: string;
  content: string;
  keywords: string[];
  timestamp: number;
  firstIndexed?: number;
  lastContentChange?: number;
  lastReferenced?: number;
}

// ── Query result types ────────────────────────────────────────────────────────

export interface ScoredTab {
  tabId: number;
  title: string;
  url: string;
  content: string;
  keywords: Set<string>;
  score: number;
}

export interface TabScoreSummary {
  tabId: number;
  title: string;
  url: string;
  score: number;
}

export interface SourceAttribution {
  tabId: number;
  title: string;
  url: string;
  score: number;
}

// ── Timeline types ────────────────────────────────────────────────────────────

export interface TimelineEntry {
  tabId: number;
  title: string;
  url: string;
  firstIndexed: number;
  lastContentChange: number;
  lastReferenced: number;
}

// ── Coherence analysis ────────────────────────────────────────────────────────

export interface CoherenceResult {
  score: number;
  topic: string;
  outliers: number[];
}

// ── Indexer class interface ───────────────────────────────────────────────────

export interface IIndexer {
  upsert(tabId: number, data: { title: string; url: string; content: string }): void;
  remove(tabId: number): void;
  markReferenced(tabIds: Iterable<number>): void;
  getTimeline(): TimelineEntry[];
  getRelevantTabs(query: string, excludeTabId?: number | null, pinnedTabIds?: Set<number> | null): ScoredTab[];
  getAllScoredTabs(query: string, excludeTabId?: number | null): TabScoreSummary[];
  buildContextString(query: string, excludeTabId?: number | null, pinnedTabIds?: Set<number> | null): string | null;
  getSourceAttribution(query: string, excludeTabId?: number | null, pinnedTabIds?: Set<number> | null): SourceAttribution[];
  getCoherenceScore(): CoherenceResult;
  size(): number;
  persist(): Promise<void>;
  persistDirty(dirtyTabIds: Set<number>): Promise<void>;
  restore(): Promise<void>;
  reconcile(): Promise<void>;
}
