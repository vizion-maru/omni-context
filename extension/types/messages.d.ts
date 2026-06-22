/**
 * All message types used in chrome.runtime message passing and port communication.
 *
 * Port messages flow between sidepanel.js ↔ background.js over a long-lived
 * chrome.runtime.Port named 'omni-chat'.
 *
 * One-shot messages use chrome.runtime.sendMessage / onMessage.
 */

// ── Chat message primitives ───────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  forgotten?: boolean;
}

export interface TokenInfo {
  inputTokens: number;
  outputTokens: number;
}

// ── Port messages: Sidepanel → Background ─────────────────────────────────────

export interface PortMsg_Chat {
  type: 'CHAT';
  messages: ChatMessage[];
  activeTabId: number | null;
  isResearch: boolean;
  focusedTabId?: number | null;
}

export interface PortMsg_CancelStream {
  type: 'CANCEL_STREAM';
}

export interface PortMsg_TestConnection {
  type: 'TEST_CONNECTION';
}

export interface PortMsg_GetTabCount {
  type: 'GET_TAB_COUNT';
}

export interface PortMsg_GetTimeline {
  type: 'GET_TIMELINE';
}

export interface PortMsg_GetCoherence {
  type: 'GET_COHERENCE';
}

export interface PortMsg_SearchTabs {
  type: 'SEARCH_TABS';
  query: string;
  domain: string;
}

export interface PortMsg_Ping {
  type: 'PING';
}

export interface PortMsg_GetLastIndexed {
  type: 'GET_LAST_INDEXED';
}

export type PortMessageToBackground =
  | PortMsg_Chat
  | PortMsg_CancelStream
  | PortMsg_TestConnection
  | PortMsg_GetTabCount
  | PortMsg_GetTimeline
  | PortMsg_GetCoherence
  | PortMsg_SearchTabs
  | PortMsg_Ping
  | PortMsg_GetLastIndexed;

// ── Port messages: Background → Sidepanel ─────────────────────────────────────

export interface PortMsg_Pong {
  type: 'PONG';
}

export interface PortMsg_TabCount {
  type: 'TAB_COUNT';
  count: number;
}

export interface PortMsg_Coherence {
  type: 'COHERENCE';
  score: number;
  topic: string;
  outliers: number[];
}

export interface PortMsg_TabGroups {
  type: 'TAB_GROUPS';
  groups: Array<{
    id: number;
    title: string;
    color: string;
    tabs: Array<{ id: number; title: string; url: string }>;
  }>;
}

export interface PortMsg_AllTabScores {
  type: 'ALL_TAB_SCORES';
  tabs: Array<{ tabId: number; title: string; url: string; score: number }>;
}

export interface PortMsg_Sources {
  type: 'SOURCES';
  sources: Array<{
    tabId: number;
    title: string;
    url: string;
    score: number;
    favicon?: string;
  }>;
}

export interface PortMsg_Timeline {
  type: 'TIMELINE';
  entries: Array<{
    tabId: number;
    title: string;
    url: string;
    firstIndexed: number;
    lastContentChange: number;
    lastReferenced: number;
  }>;
}

export interface PortMsg_TokenBudget {
  type: 'TOKEN_BUDGET';
  used: number;
  max: number;
  model: string;
}

export interface PortMsg_SearchTabsResult {
  type: 'SEARCH_TABS_RESULT';
  results: Array<{
    tabId: number;
    title: string;
    url: string;
    score: number;
    snippet: string;
  }>;
  domains: string[];
}

export interface PortMsg_LastIndexed {
  type: 'LAST_INDEXED';
  timestamp: number;
}

export interface PortMsg_Start {
  type: 'START';
}

export interface PortMsg_Chunk {
  type: 'CHUNK';
  text: string;
}

export interface PortMsg_Done {
  type: 'DONE';
  tokenInfo?: TokenInfo;
}

export interface PortMsg_Error {
  type: 'ERROR';
  error: string;
}

export interface PortMsg_QuotaWarning {
  type: 'QUOTA_WARNING';
}

export interface PortMsg_TestResult {
  type: 'TEST_RESULT';
  ok: boolean;
  error?: string;
}

export type PortMessageToSidepanel =
  | PortMsg_Pong
  | PortMsg_TabCount
  | PortMsg_Coherence
  | PortMsg_TabGroups
  | PortMsg_AllTabScores
  | PortMsg_Sources
  | PortMsg_Timeline
  | PortMsg_TokenBudget
  | PortMsg_SearchTabsResult
  | PortMsg_LastIndexed
  | PortMsg_Start
  | PortMsg_Chunk
  | PortMsg_Done
  | PortMsg_Error
  | PortMsg_QuotaWarning
  | PortMsg_TestResult;

// ── One-shot messages: Content Script → Background ────────────────────────────

export interface RuntimeMsg_TabContent {
  type: 'TAB_CONTENT';
  title: string;
  url: string;
  content: string;
}

// ── One-shot messages: Background → Content Script ────────────────────────────

export interface RuntimeMsg_ExtractContent {
  type: 'EXTRACT_CONTENT';
}

export interface RuntimeMsg_HighlightPassage {
  type: 'HIGHLIGHT_PASSAGE';
  query: string;
}

// ── One-shot messages: Sidepanel/Options → Background (request + response) ────

export interface RuntimeMsg_GetSettings {
  type: 'GET_SETTINGS';
}

export interface RuntimeMsg_ReindexAll {
  type: 'REINDEX_ALL';
}

export interface RuntimeMsg_GetIndexSize {
  type: 'GET_INDEX_SIZE';
}

export interface RuntimeMsg_GetHistory {
  type: 'GET_HISTORY';
}

export interface RuntimeMsg_DeleteHistoryItem {
  type: 'DELETE_HISTORY_ITEM';
  id: string;
}

export interface RuntimeMsg_ClearHistory {
  type: 'CLEAR_HISTORY';
}

export interface RuntimeMsg_GetHistorySize {
  type: 'GET_HISTORY_SIZE';
}

export interface RuntimeMsg_GetLastIndexed {
  type: 'GET_LAST_INDEXED';
}

export interface RuntimeMsg_GetTabGroups {
  type: 'GET_TAB_GROUPS';
}

export interface RuntimeMsg_OpenPaymentPage {
  type: 'OPEN_PAYMENT_PAGE';
}

export interface RuntimeMsg_GetDailyUsage {
  type: 'GET_DAILY_USAGE';
}

export interface RuntimeMsg_GetWeeklyUsage {
  type: 'GET_WEEKLY_USAGE';
}

export interface RuntimeMsg_ResetUsage {
  type: 'RESET_USAGE';
}

export interface RuntimeMsg_GetExclusionList {
  type: 'GET_EXCLUSION_LIST';
}

export interface RuntimeMsg_SetExclusionList {
  type: 'SET_EXCLUSION_LIST';
  domains: string[];
}

export interface RuntimeMsg_GetPinnedList {
  type: 'GET_PINNED_LIST';
}

export interface RuntimeMsg_SetPinnedList {
  type: 'SET_PINNED_LIST';
  domains: string[];
}

export interface RuntimeMsg_ExcludeDomain {
  type: 'EXCLUDE_DOMAIN';
  domain: string;
}

export interface RuntimeMsg_UnexcludeDomain {
  type: 'UNEXCLUDE_DOMAIN';
  domain: string;
}

export interface RuntimeMsg_PinDomain {
  type: 'PIN_DOMAIN';
  domain: string;
}

export interface RuntimeMsg_UnpinDomain {
  type: 'UNPIN_DOMAIN';
  domain: string;
}

export interface RuntimeMsg_OAuthStart {
  type: 'OAUTH_START';
  provider: string;
}

export interface RuntimeMsg_OAuthDisconnect {
  type: 'OAUTH_DISCONNECT';
}

export type RuntimeMessageToBackground =
  | RuntimeMsg_TabContent
  | RuntimeMsg_GetSettings
  | RuntimeMsg_ReindexAll
  | RuntimeMsg_GetIndexSize
  | RuntimeMsg_GetHistory
  | RuntimeMsg_DeleteHistoryItem
  | RuntimeMsg_ClearHistory
  | RuntimeMsg_GetHistorySize
  | RuntimeMsg_GetLastIndexed
  | RuntimeMsg_GetTabGroups
  | RuntimeMsg_OpenPaymentPage
  | RuntimeMsg_GetDailyUsage
  | RuntimeMsg_GetWeeklyUsage
  | RuntimeMsg_ResetUsage
  | RuntimeMsg_GetExclusionList
  | RuntimeMsg_SetExclusionList
  | RuntimeMsg_GetPinnedList
  | RuntimeMsg_SetPinnedList
  | RuntimeMsg_ExcludeDomain
  | RuntimeMsg_UnexcludeDomain
  | RuntimeMsg_PinDomain
  | RuntimeMsg_UnpinDomain
  | RuntimeMsg_OAuthStart
  | RuntimeMsg_OAuthDisconnect;

export type RuntimeMessageToContentScript =
  | RuntimeMsg_ExtractContent
  | RuntimeMsg_HighlightPassage;

// ── Response shapes ───────────────────────────────────────────────────────────

export interface SettingsResponse {
  provider: string | null;
  apiKey: string | null;
  model: string | null;
  oauthProvider: string | null;
  oauthAccessToken: string | null;
  oauthRefreshToken: string | null;
  oauthTokenExpiry: number | null;
}

export interface UsageResponse {
  input: number;
  output: number;
  queries: number;
  providers: Record<string, Record<string, { input: number; output: number; queries: number }>>;
  cost: { total: number; breakdown: Array<{ provider: string; model: string; cost: number }> };
}

export interface HistorySession {
  id: string;
  timestamp: number;
  messages: ChatMessage[];
  tabs: Array<{ tabId: number; title: string; url: string; score: number }>;
  model: string;
  provider: string;
  coherenceScore: number;
  isResearch: boolean;
}
