// HistoryView.jsx — Omni-Context chat history view

const MOCK_SESSIONS = [
  {
    id: '1', timestamp: Date.now() - 2 * 60000, model: 'gpt-4o-mini',
    isResearch: false,
    messages: [
      { role: 'user', content: 'What does the Anthropic SDK streaming API look like?' },
      { role: 'assistant', content: 'The Anthropic SDK exposes a `streamChat` method that uses SSE. You pass messages and a context string, and receive chunks via a callback. [Tab: GitHub — anthropics/anthropic-sdk]' },
    ],
    tabs: [
      { title: 'GitHub — anthropics/anthropic-sdk', url: 'https://github.com/anthropics/anthropic-sdk-python' },
      { title: 'MDN: fetch() - Web APIs', url: 'https://developer.mozilla.org/en-US/docs/Web/API/fetch' },
    ],
  },
  {
    id: '2', timestamp: Date.now() - 45 * 60000, model: 'claude-3-5-haiku-20241022',
    isResearch: true,
    messages: [
      { role: 'user', content: 'Summarize all the articles I have open about React Server Components.' },
      { role: 'assistant', content: 'Based on all open tabs, here is a research summary of React Server Components...' },
    ],
    tabs: [
      { title: 'React Docs: Server Components', url: 'https://react.dev/reference/rsc/server-components' },
    ],
  },
  {
    id: '3', timestamp: Date.now() - 2 * 86400000, model: 'gemini-2.0-flash',
    isResearch: false,
    messages: [
      { role: 'user', content: 'How does Chrome extension messaging work?' },
      { role: 'assistant', content: 'Chrome extensions use a message-passing system via `chrome.runtime.sendMessage` and `chrome.runtime.onMessage`...' },
    ],
    tabs: [],
  },
];

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (diff < 60000) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

function HistoryCard({ session, onDelete }) {
  const [open, setOpen] = React.useState(false);
  const firstUser = session.messages.find(m => m.role === 'user');

  return (
    <div style={historyStyles.card}>
      <div style={historyStyles.cardSummary} onClick={() => setOpen(o => !o)}>
        <span style={{ fontSize: 8, color: '#5a5e78', transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>▶</span>
        <div style={historyStyles.cardMeta}>
          <span style={historyStyles.cardTime}>{formatRelativeTime(session.timestamp)}</span>
          <span style={historyStyles.cardPreview}>{firstUser?.content || '(empty)'}</span>
        </div>
        <div style={historyStyles.cardBadges}>
          {session.model && <span style={historyStyles.badge}>{session.model.split('/').pop().slice(0, 14)}</span>}
          {session.isResearch && <span style={historyStyles.badge} title="Research mode">🔬</span>}
        </div>
        <button
          style={historyStyles.deleteBtn}
          onClick={e => { e.stopPropagation(); onDelete(session.id); }}
          title="Delete"
        >×</button>
      </div>

      {open && (
        <div style={historyStyles.cardBody}>
          <div style={historyStyles.messages}>
            {session.messages.map((m, i) => (
              <div key={i} style={{
                ...historyStyles.histMsg,
                ...(m.role === 'user' ? historyStyles.histMsgUser : {}),
              }}>
                {m.content}
              </div>
            ))}
          </div>
          {session.tabs.length > 0 && (
            <div style={historyStyles.tabsSection}>
              <div style={historyStyles.tabsHeader}>
                <span style={historyStyles.tabsLabel}>Tabs ({session.tabs.length})</span>
                <button style={historyStyles.openAllBtn}>Open all</button>
              </div>
              {session.tabs.map((tab, i) => (
                <div key={i} style={historyStyles.tabItem}>
                  <span style={historyStyles.tabTitle}>{tab.title}</span>
                  <button style={historyStyles.openTabBtn}>↗</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryView() {
  const [sessions, setSessions] = React.useState(MOCK_SESSIONS);
  const [query, setQuery] = React.useState('');

  const filtered = query.trim()
    ? sessions.filter(s =>
        s.messages.some(m => m.content.toLowerCase().includes(query.toLowerCase())) ||
        s.tabs.some(t => t.title.toLowerCase().includes(query.toLowerCase()))
      )
    : sessions;

  const handleDelete = (id) => setSessions(prev => prev.filter(s => s.id !== id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div style={historyStyles.toolbar}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search history..."
          style={historyStyles.searchInput}
        />
        <button
          style={historyStyles.dangerSmBtn}
          onClick={() => { if (window.confirm('Delete all history?')) setSessions([]); }}
        >Delete all</button>
      </div>
      <div style={historyStyles.list}>
        {filtered.length === 0
          ? <div style={historyStyles.empty}>No chat history yet.</div>
          : filtered.map(s => <HistoryCard key={s.id} session={s} onDelete={handleDelete} />)
        }
      </div>
    </div>
  );
}

const historyStyles = {
  toolbar: {
    display: 'flex', gap: 8, padding: '10px 12px 8px',
    background: '#1a1d27', borderBottom: '1px solid #2c2f45', flexShrink: 0,
  },
  searchInput: {
    flex: 1, background: '#0f1117', border: '1px solid #2c2f45',
    borderRadius: 6, color: '#e2e4f0', fontFamily: 'inherit',
    fontSize: 12, padding: '5px 10px', outline: 'none',
  },
  dangerSmBtn: {
    background: 'none', border: '1px solid #3d1515',
    borderRadius: 6, color: '#ef4444', fontFamily: 'inherit',
    fontSize: 11, padding: '4px 9px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
  },
  list: {
    flex: 1, overflowY: 'auto', padding: '8px 10px',
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  empty: { textAlign: 'center', color: '#5a5e78', fontSize: 12, padding: '24px 0' },
  card: {
    background: '#1a1d27', border: '1px solid #2c2f45',
    borderRadius: 6, overflow: 'hidden',
  },
  cardSummary: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 10px', cursor: 'pointer', userSelect: 'none',
  },
  cardMeta: { flex: 1, minWidth: 0 },
  cardTime: { fontSize: 10, color: '#5a5e78', display: 'block', marginBottom: 2 },
  cardPreview: {
    fontSize: 12, color: '#e2e4f0',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block',
  },
  cardBadges: { display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' },
  badge: {
    fontSize: 9, padding: '1px 5px', borderRadius: 10,
    background: '#222536', color: '#5a5e78', border: '1px solid #2c2f45',
  },
  deleteBtn: {
    background: 'none', border: 'none', color: '#5a5e78',
    cursor: 'pointer', fontSize: 14, padding: '2px 4px',
    borderRadius: 3, flexShrink: 0, lineHeight: 1,
  },
  cardBody: { padding: '0 10px 10px', borderTop: '1px solid #2c2f45' },
  messages: {
    display: 'flex', flexDirection: 'column', gap: 6,
    padding: '8px 0 6px', maxHeight: 200, overflowY: 'auto',
  },
  histMsg: {
    fontSize: 11.5, lineHeight: 1.5, padding: '5px 8px',
    borderRadius: 6, wordBreak: 'break-word', color: '#e2e4f0',
  },
  histMsgUser: {
    background: '#222536', color: '#d4e3ff',
    alignSelf: 'flex-end', maxWidth: '90%',
  },
  tabsSection: { borderTop: '1px solid #2c2f45', paddingTop: 8, marginTop: 4 },
  tabsHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6,
  },
  tabsLabel: {
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: '#5a5e78',
  },
  openAllBtn: {
    fontSize: 10, padding: '2px 8px', borderRadius: 6,
    background: '#222536', border: '1px solid #2c2f45',
    color: '#8b8fa8', cursor: 'pointer',
  },
  tabItem: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 6, fontSize: 11, padding: '3px 0',
    borderBottom: '1px solid rgba(44,47,69,0.4)',
  },
  tabTitle: {
    flex: 1, minWidth: 0, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#8b8fa8',
  },
  openTabBtn: {
    fontSize: 10, padding: '1px 6px', borderRadius: 3,
    background: 'none', border: '1px solid #2c2f45',
    color: '#5a5e78', cursor: 'pointer', flexShrink: 0,
  },
};

Object.assign(window, { HistoryView });
