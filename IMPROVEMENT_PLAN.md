# Omni-Context Extension — Comprehensive Improvement Plan

> **Version analyzed:** 3.5.0 (Manifest V3)  
> **Date:** 2026-06-21  
> **Architecture:** Service worker background + side panel chat + content script extraction + 10 AI providers (BYOK)

---

## Executive Summary

Omni-Context is a well-structured Chrome extension that indexes open browser tabs and uses AI (user's own API key) to answer questions across tab content. The extension has a solid foundation but suffers from mixed-language UI strings, a critical bug in compare mode, performance bottlenecks in the reindexing loop, and lacks several features that would significantly improve the user experience.

---

## 🐛 Priority 1: Critical Bugs & Code Quality

### 1.1 Compare Mode Null Reference Bug
**File:** `sidepanel.js` line 1037-1038  
**Impact:** Crash when comparing two sources  
```js
// BUG: compareFirstChip set to null BEFORE accessing .classList
compareMode = false;
compareFirstChip = null;           // ← set to null
compareFirstChip.classList.remove('comparing'); // ← null reference!
```
**Fix:** Reorder — remove class before nulling the reference.

### 1.2 Mixed Language UI (German/English)
**Files:** `sidepanel.js`, `sidepanel.html`, `options.js`  
**Impact:** Confusing UX for non-German users  
**Examples:**
- `"Gerade eben"`, `"Vor ${minutes} Min"`, `"Gestern"` (time formatting)
- `"Verwendete Tabs"`, `"nicht relevante Tabs"` (tab relevance)
- `"Recherche aufbauen"` (research button label in HTML)
- `"Erst API Key eingeben"` (model dropdown placeholder)
- `"Timeout: Antwort nach 60s ohne Daten abgebrochen"` (error message)
- `"Kein passender Tab gefunden"` (no-match warning)

**Fix:** Centralize all user-facing strings into a locale module. Default to English, add i18n support via Chrome's `_locales/` system.

### 1.3 Unhandled `TAB_CONTENT` Message
**Files:** `content.js` line 86, `background.js`  
The content script sends `{ type: 'TAB_CONTENT', ...data }` on `autoIndex()`, but the background's `onMessage` handler has no case for `'TAB_CONTENT'`. This message is silently dropped.  
**Fix:** Add handler or remove the dead `autoIndex()` send.

### 1.4 Duplicated Utility Code
- `escHtml()` defined in both `lib/utils.js` and `sidepanel.js`
- `FALLBACK_MODELS` duplicated between `options.js` and `lib/utils.js`
- `FREE_PROVIDERS` duplicated between `feature-gates.js` and `options.js`

**Fix:** Consolidate into shared modules. For non-module scripts (sidepanel), either convert to modules or use a build step.

### 1.5 Swallowed Errors Pattern
Throughout the codebase, errors are caught with empty `catch (_) {}` blocks (30+ instances). Critical failures in indexing, persistence, or OAuth silently disappear.  
**Fix:** Add structured error logging with a ring buffer that can be viewed in options page for debugging.

---

## 🚀 Priority 2: Performance Optimizations

### 2.1 Aggressive Reindex Loop
**File:** `background.js` line 44-47  
**Problem:** `reindexAllTabs()` runs every 60 seconds, re-extracting content from ALL tabs regardless of whether they changed.  
**Impact:** Excessive CPU, content script invocations, and storage writes.  
**Fix:**
- Track `lastModified` per tab (using `changeInfo.url` or content hash)
- Only re-extract tabs whose URL or load status changed since last index
- Increase interval to 5 minutes for unchanged tabs; immediate for navigated tabs

### 2.2 O(n²) Coherence Score
**File:** `lib/indexer.js` lines 148-200  
**Problem:** `getCoherenceScore()` computes Jaccard similarity between every pair of tabs. With 50 tabs = 2,450 pair comparisons.  
**Fix:** Cache the coherence score and invalidate only when index changes. Alternatively, use a sampling approach for >20 tabs.

### 2.3 Full Index Persistence on Every Change
**File:** `background.js` — `schedulePersist()` serializes the entire index every 2 seconds after any change.  
**Fix:** Implement incremental persistence — only write changed entries. Use a dirty-set to track modified tab IDs.

### 2.4 Redundant Tab Queries
**File:** `background.js` `extractAndIndex()` — calls `chrome.tabs.get(tabId)` up to 3 times (lines 94, 106, 140).  
**Fix:** Query once and pass the tab object through the function.

### 2.5 Content Script Extraction Limit
**File:** `content.js` — `MAX_CONTENT_CHARS = 8000`  
For long articles or documentation pages, 8K chars captures very little. Meanwhile `MAX_CONTEXT_CHARS_TOTAL = 20000` in the indexer limits total context to AI.  
**Fix:** Increase per-tab extraction to 16K-24K chars, implement smart sectioning (extract headings + first paragraphs of each section rather than a flat slice).

### 2.6 Keyword Set Recomputation
**File:** `lib/indexer.js` `_score()` and `_extractKeywords()`  
Keywords are stored per entry but query keywords are recomputed on every call to `getRelevantTabs`, `getAllScoredTabs`, and `buildContextString`.  
**Fix:** Cache query keyword extraction in the call chain (single extraction, pass through).

---

## ✨ Priority 3: New Features

### 3.1 Full-Text Tab Search
**Description:** Allow users to search indexed tab content directly (not via AI), similar to browser history search but across live content.  
**Implementation:**
- Add search bar in the context bar section
- Use the existing keyword index for fast filtering
- Show matching tabs with highlighted snippets
- Enable filtering by domain, tab group, or date indexed

### 3.2 Conversation Persistence
**Problem:** Closing and reopening the side panel loses the current conversation.  
**Fix:** Persist current `messages[]` array to `chrome.storage.session` (session-scoped, cleared on browser close). Restore on panel open.

### 3.3 Token Usage Tracking & Cost Estimation
**Description:** Show users how many tokens they're consuming per query and estimated cost.  
**Implementation:**
- Count input/output tokens (use char/4 heuristic or exact tokenizer for OpenAI)
- Store cumulative usage per day/week
- Show cost estimate based on provider pricing
- Add usage dashboard in options page

### 3.4 Tab Exclusion & Pinning
**Description:** Let users exclude specific tabs or domains from indexing, and pin important tabs for always-include in context.  
**Implementation:**
- Right-click context menu on tab → "Exclude from Omni-Context"
- Exclusion list in options (domain patterns)
- Pinned tabs always included in context regardless of relevance score

### 3.5 Custom System Prompts
**Description:** Allow Pro users to customize the system prompt for specialized use cases (code review, legal analysis, etc.).  
**Implementation:**
- Textarea in options page for custom prompt prefix/suffix
- Template variables: `{TAB_CONTENT}`, `{TAB_COUNT}`, `{QUERY}`
- Preset library (Research, Code Review, Summarization, Q&A)

### 3.6 Export Formats
**Description:** Expand export beyond Markdown.  
**Formats:**
- PDF export (via browser print)
- JSON export (structured conversation + metadata)
- HTML export (styled, self-contained)
- Clipboard copy (single message or full conversation)

### 3.7 Cross-Device Sync (Pro)
**Description:** Sync conversation history and settings across devices.  
**Implementation:**
- Use `chrome.storage.sync` for settings (already partially done)
- For history: optional encrypted backup to user's cloud storage (Google Drive API)
- Sync exclusion/pinning lists

### 3.8 Semantic Search with Embeddings
**Description:** Replace keyword-based relevance with embedding similarity for much better results.  
**Implementation:**
- Generate embeddings via the user's configured provider (OpenAI `text-embedding-3-small`, etc.)
- Store embeddings alongside content in the index
- Cosine similarity for query-to-tab matching
- Fall back to keyword matching if no embedding API available

### 3.9 Tab Activity Timeline
**Description:** Visual timeline showing when tabs were indexed, which were used in queries, and content freshness.  
**Implementation:**
- Track timestamps for: first indexed, last content change, last referenced in query
- Show timeline in the context bar detail view
- Highlight stale tabs that haven't been refreshed

### 3.10 Multi-Turn Context Window Management
**Description:** Intelligent context window management for long conversations.  
**Implementation:**
- Auto-summarize earlier messages when approaching token limits
- Show token budget indicator in the input area
- Allow user to "forget" specific messages from context
- Smart context selection: only include tabs relevant to the current turn

---

## 🎨 Priority 4: UI/UX Improvements

### 4.1 Internationalization (i18n)
**Impact:** High — currently alienates non-German speakers  
**Implementation:**
- Use Chrome's `chrome.i18n` API with `_locales/` directory
- Start with English (default) and German
- Replace all hardcoded strings with `chrome.i18n.getMessage()` calls

### 4.2 Theme Support (Light/Dark/System)
**Current:** Hardcoded dark theme in `design-tokens.css`  
**Fix:** Add CSS custom properties that switch based on `prefers-color-scheme` or user preference stored in settings.

### 4.3 Clear Conversation Button
**Problem:** No way to start a fresh conversation without closing/reopening the panel.  
**Fix:** Add a "New Chat" button in the header that clears `messages[]` and resets the UI.

### 4.4 Message Actions
**Description:** Add per-message action buttons:
- Copy to clipboard
- Regenerate (resend with same context)
- Edit and resend (for user messages)
- React/bookmark important answers

### 4.5 Streaming Progress Indicator
**Problem:** Only "Thinking…" spinner, no indication of progress.  
**Fix:** Show word/token count as streaming progresses. Add elapsed time indicator.

### 4.6 Responsive Input Area
**Problem:** Input area has fixed positioning issues on small panels.  
**Fix:** Better responsive layout that adapts to narrow side panel widths (minimum ~320px).

### 4.7 Tab Relevance Visualization
**Current:** Simple percentage list.  
**Improvement:** Visual bar chart showing relative relevance. Color-coded by tab group. Click-to-focus (only use that tab's content for the next query).

### 4.8 Onboarding Flow
**Problem:** New users see "No tabs indexed" with minimal guidance.  
**Fix:** Step-by-step onboarding:
1. Choose provider
2. Enter API key (with test)
3. Browse 3+ tabs
4. Ask first question
5. Celebrate success

### 4.9 Keyboard Shortcuts Enhancement
**Current:** Only Ctrl+K (focus input), Ctrl+Shift+M (mindmap)  
**Add:**
- `Ctrl+Shift+N` — New conversation
- `Ctrl+Shift+E` — Export
- `Escape` — Cancel streaming
- `↑` in empty input — Recall last question
- `/` prefix commands: `/search`, `/compare`, `/summarize all`

### 4.10 Accessibility Improvements
- Add ARIA labels to all interactive elements
- Ensure keyboard navigation works throughout
- Add focus indicators
- Screen reader support for streaming messages
- Respect `prefers-reduced-motion`

---

## 🏗️ Priority 5: Architecture & Developer Experience

### 5.1 Build System
**Current:** No build step — raw JS files loaded directly.  
**Recommendation:** Add a minimal build system:
- Rollup or esbuild for bundling
- CSS autoprefixer
- Minification for production builds
- Source maps for debugging
- Environment variables (dev vs prod)

### 5.2 Testing Infrastructure
**Current:** No tests.  
**Add:**
- Unit tests for `indexer.js` (keyword extraction, scoring, coherence)
- Unit tests for `providers.js` (request construction, error handling)
- Integration tests for message passing (background ↔ sidepanel)
- Use Vitest or Jest with chrome mock

### 5.3 TypeScript Migration
**Rationale:** The codebase is 3K+ lines with complex message passing. Types would prevent bugs like the null reference in compare mode.  
**Approach:** Incremental — start with `.d.ts` files for message types and provider interfaces, then migrate file by file.

### 5.4 Error Boundary & Recovery
**Problem:** Silent failures throughout.  
**Fix:**
- Add error boundary in sidepanel that catches rendering errors
- Service worker crash recovery (re-init on wake)
- Graceful degradation when storage quota exceeded
- User-visible error log (debug panel in options)

### 5.5 Content Security Policy
**Current:** No CSP defined in manifest.  
**Risk:** Mermaid renders SVG with `securityLevel: 'loose'` — potential XSS vector if AI returns malicious mermaid syntax.  
**Fix:** Add CSP to manifest, tighten mermaid security level, sanitize AI output before mermaid rendering.

---

## 📋 Implementation Roadmap

### Phase 1 — Stability (1-2 weeks)
| Task | Priority | Effort |
|------|----------|--------|
| Fix compare mode null bug | P0 | 5 min |
| Fix unhandled TAB_CONTENT message | P0 | 15 min |
| Consolidate English strings | P1 | 2-3 hours |
| Add error logging ring buffer | P1 | 2 hours |
| Deduplicate utility code | P1 | 1 hour |
| Fix reindex loop (change detection) | P1 | 3 hours |
| Cache coherence score | P2 | 1 hour |

### Phase 2 — Core UX (2-4 weeks)
| Task | Priority | Effort |
|------|----------|--------|
| Conversation persistence | P1 | 2 hours |
| New Chat / Clear button | P1 | 30 min |
| Full i18n system (EN + DE) | P1 | 1 day |
| Light/Dark theme support | P2 | 4 hours |
| Message copy/actions | P2 | 3 hours |
| Tab search in context bar | P2 | 4 hours |
| Keyboard shortcuts expansion | P2 | 2 hours |
| Cancel streaming | P2 | 1 hour |

### Phase 3 — Power Features (4-8 weeks)
| Task | Priority | Effort |
|------|----------|--------|
| Token usage tracking | P2 | 1 day |
| Tab exclusion/pinning | P2 | 1 day |
| Custom system prompts (Pro) | P2 | 1 day |
| Export format expansion | P3 | 1 day |
| Embedding-based search (Pro) | P3 | 3-5 days |
| Smart content extraction | P3 | 2 days |
| Onboarding flow | P3 | 2 days |

### Phase 4 — Infrastructure (Ongoing)
| Task | Priority | Effort |
|------|----------|--------|
| Add build system (esbuild) | P2 | 1 day |
| Unit tests for indexer | P2 | 1 day |
| TypeScript types file | P3 | 2 days |
| CSP hardening | P2 | 2 hours |
| Cross-device sync (Pro) | P3 | 1 week |
| Accessibility audit | P3 | 2-3 days |

---

## Metrics for Success

- **Bug rate:** Zero crash reports from compare mode and null references
- **Performance:** Reindex cycle CPU time reduced by 80%+ (change detection)
- **UX:** Time-to-first-answer < 3 seconds for returning users (conversation persistence)
- **Engagement:** Session length increase from conversation persistence + follow-up suggestions
- **i18n:** Zero German strings visible to English-locale users
- **Storage:** 50% reduction in storage writes (incremental persistence)

---

## Technical Debt Summary

| Area | Severity | Description |
|------|----------|-------------|
| Language mixing | High | German strings in English-defaulting extension |
| No tests | High | No safety net for refactoring |
| Error swallowing | Medium | 30+ empty catch blocks hide failures |
| No build step | Medium | Can't use modern tooling, tree-shaking, or minification |
| Hardcoded limits | Low | Magic numbers (8000, 20000, 60000ms) not configurable |
| No CSP | Low | Potential XSS via mermaid SVG injection |
| Code duplication | Low | Multiple copies of utility functions and constant lists |
