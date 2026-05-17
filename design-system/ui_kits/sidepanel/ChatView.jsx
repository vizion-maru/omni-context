// ChatView.jsx — Omni-Context chat view (messages + input)

const { useState, useEffect, useRef } = React;

// ── Sub-components ────────────────────────────────────────────────────────────

function SourceChip({ label }) {
  return (
    <span style={chatStyles.sourceChip}>{label}</span>
  );
}

function TabRelevanceBar({ tabs }) {
  const [open, setOpen] = React.useState(tabs.length <= 4);
  const relevant = tabs.filter(t => t.score >= 0.05);
  const irrelevant = tabs.filter(t => t.score < 0.05);

  return (
    <div style={chatStyles.relevanceWrap}>
      <div style={chatStyles.relevanceCard}>
        <div
          style={chatStyles.relevanceSummary}
          onClick={() => setOpen(o => !o)}
        >
          <span style={{ fontSize: 8, color: '#5a5e78', transition: 'transform 0.15s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
          <span>📋 Used tabs</span>
          <span style={chatStyles.relevanceCount}>{relevant.length}</span>
        </div>
        {open && (
          <div style={chatStyles.relevanceContent}>
            {relevant.map((tab, i) => (
              <div key={i} style={chatStyles.relevanceItem}>
                <span style={chatStyles.relevanceTitle}>{tab.title}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: '#22c55e', flexShrink: 0 }}>{Math.round(tab.score * 100)}%</span>
              </div>
            ))}
            {irrelevant.length > 0 && (
              <div style={{ fontSize: 10, color: '#5a5e78', marginTop: 4 }}>{irrelevant.length} irrelevant tabs</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function UserMessage({ text }) {
  return (
    <div style={chatStyles.msg}>
      <div style={{ ...chatStyles.avatar, background: '#1e3a6e', color: '#3B82F6' }}>U</div>
      <div style={chatStyles.msgBody}>
        <div style={chatStyles.msgRole}>You</div>
        <div style={{ ...chatStyles.msgText, color: '#d4e3ff', whiteSpace: 'pre-wrap' }}>{text}</div>
      </div>
    </div>
  );
}

function AssistantMessage({ text, streaming = false }) {
  // Very simple inline markdown: **bold**, `code`, [Tab: x]
  const renderText = (t) => {
    if (!t) return streaming ? <span style={chatStyles.cursor} /> : null;
    const parts = [];
    let remaining = t;
    let key = 0;

    const patterns = [
      { re: /\*\*(.+?)\*\*/g, render: (m, c) => <strong key={key++} style={{ color: '#e2e4f0', fontWeight: 600 }}>{c}</strong> },
      { re: /`([^`]+)`/g, render: (m, c) => <code key={key++} style={chatStyles.inlineCode}>{c}</code> },
      { re: /\[Tab:\s*([^\]]+?)\]/g, render: (m, c) => <span key={key++} style={chatStyles.sourceChip}>{c.trim()}</span> },
    ];

    // Simple sequential split approach
    const segments = remaining.split(/(\*\*[^*]+\*\*|`[^`]+`|\[Tab:[^\]]+\])/g);
    return segments.map((seg, i) => {
      if (seg.startsWith('**') && seg.endsWith('**')) return <strong key={i} style={{ color: '#e2e4f0', fontWeight: 600 }}>{seg.slice(2, -2)}</strong>;
      if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1) return <code key={i} style={chatStyles.inlineCode}>{seg.slice(1, -1)}</code>;
      if (seg.startsWith('[Tab:')) { const c = seg.replace(/\[Tab:\s*|\]/g, '').trim(); return <span key={i} style={chatStyles.sourceChip}>{c}</span>; }
      return seg;
    }).concat(streaming ? [<span key="cursor" style={chatStyles.cursor} />] : []);
  };

  return (
    <div style={chatStyles.msg}>
      <div style={{ ...chatStyles.avatar, background: 'linear-gradient(135deg,#3B82F6,#818cf8)', color: 'white', fontSize: 13 }}>◆</div>
      <div style={chatStyles.msgBody}>
        <div style={chatStyles.msgRole}>Omni-Context</div>
        <div style={chatStyles.msgText}>{renderText(text)}</div>
      </div>
    </div>
  );
}

function WelcomeState({ hasApiKey }) {
  return (
    <div style={chatStyles.welcome}>
      <div style={{ fontSize: 28, marginBottom: 4 }}>🔍</div>
      <h2 style={{ fontSize: 14, fontWeight: 600, color: '#e2e4f0' }}>Ask across your tabs</h2>
      <p style={{ fontSize: 12, lineHeight: 1.65, color: '#8b8fa8', maxWidth: 240, textAlign: 'center' }}>
        Browse some pages, then ask a question. Omni-Context reads your open tabs and uses AI to answer.
      </p>
      {!hasApiKey && (
        <div style={chatStyles.noKeyBanner}>
          <strong style={{ display: 'block', marginBottom: 3 }}>🔑 API key required</strong>
          Click Settings to add your OpenAI, Anthropic, or other API key to get started.
        </div>
      )}
    </div>
  );
}

function ContextBar({ tabCount }) {
  const [open, setOpen] = React.useState(false);
  const mockTabs = [
    { title: 'GitHub — anthropics/anthropic-sdk', score: 0.92 },
    { title: 'MDN: fetch() - Web APIs', score: 0.74 },
    { title: 'Hacker News | Ask HN: LLM tools', score: 0.45 },
    { title: 'Stack Overflow — async/await', score: 0.23 },
  ];
  return (
    <div style={{ background: '#222536', borderTop: '1px solid #2c2f45', flexShrink: 0 }}>
      <div style={chatStyles.contextBarSummary} onClick={() => setOpen(o => !o)}>
        <span>💾</span>
        <span>Using <span style={{ color: '#3B82F6', fontWeight: 600 }}>{tabCount}</span> indexed tabs as context</span>
        <span style={{ marginLeft: 'auto', fontSize: 8, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </div>
      {open && (
        <div style={{ padding: '4px 12px 8px', display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 140, overflowY: 'auto' }}>
          {mockTabs.slice(0, tabCount).map((tab, i) => {
            const pct = Math.round(tab.score * 100);
            const cls = pct >= 50 ? '#22c55e' : pct >= 20 ? '#f59e0b' : '#5a5e78';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '3px 0', borderBottom: '1px solid rgba(44,47,69,0.4)' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#8b8fa8' }}>{tab.title}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: cls, flexShrink: 0 }}>{pct}%</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InputArea({ onSend, disabled, researchMode, onResearchToggle }) {
  const [value, setValue] = React.useState('');
  const textareaRef = useRef(null);

  const handleSend = () => {
    if (!value.trim() || disabled) return;
    onSend(value.trim());
    setValue('');
    if (textareaRef.current) { textareaRef.current.style.height = 'auto'; }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleInput = (e) => {
    setValue(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
  };

  return (
    <div style={chatStyles.inputArea}>
      <div style={{ marginBottom: 6, display: 'flex', gap: 6 }}>
        <button
          style={{ ...chatStyles.actionBtn, ...(researchMode ? chatStyles.actionBtnActive : {}) }}
          onClick={onResearchToggle}
        >
          🔬 Research mode
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={researchMode ? 'Research question: all tabs will be analyzed...' : 'Ask a question about your open tabs...'}
          rows={1}
          style={{
            ...chatStyles.inputBox,
            ...(disabled ? { opacity: 0.5 } : {}),
          }}
        />
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          style={{
            ...chatStyles.sendBtn,
            ...(disabled || !value.trim() ? chatStyles.sendBtnDisabled : {}),
          }}
        >
          ➤
        </button>
      </div>
    </div>
  );
}

// ── Main ChatView ─────────────────────────────────────────────────────────────

function ChatView({ hasApiKey, onOpenSettings }) {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [researchMode, setResearchMode] = useState(false);
  const [tabCount, setTabCount] = useState(4);
  const [showRelevance, setShowRelevance] = useState(false);
  const messagesEndRef = useRef(null);

  const MOCK_RESPONSE = `Based on the indexed tabs, here's what I found:\n\nThe **Anthropic SDK** [Tab: GitHub — anthropics/anthropic-sdk] exposes a \`streamChat\` method that uses SSE under the hood. Combined with the \`fetch()\` API [Tab: MDN: fetch() - Web APIs], you can pipe chunks directly into the DOM without buffering the full response.\n\nThis pattern is consistent with what the Hacker News thread [Tab: Hacker News | Ask HN: LLM tools] describes as the preferred approach for low-latency chat UIs.`;

  const mockTabs = [
    { title: 'GitHub — anthropics/anthropic-sdk', score: 0.92 },
    { title: 'MDN: fetch() - Web APIs', score: 0.74 },
    { title: 'Hacker News | Ask HN: LLM tools', score: 0.45 },
    { title: 'Stack Overflow — async/await', score: 0.04 },
  ];

  const scrollToBottom = () => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollTop = messagesEndRef.current.scrollHeight;
    }
  };

  useEffect(() => { scrollToBottom(); }, [messages, streamText]);

  const handleSend = (text) => {
    if (!hasApiKey) { onOpenSettings(); return; }
    setMessages(prev => [...prev, { role: 'user', text }]);
    setShowRelevance(false);
    setStreaming(true);
    setStreamText('');

    // Simulate tab relevance appearing first
    setTimeout(() => setShowRelevance(true), 300);

    // Simulate streaming
    let i = 0;
    const full = MOCK_RESPONSE;
    const interval = setInterval(() => {
      i += 3;
      setStreamText(full.slice(0, i));
      if (i >= full.length) {
        clearInterval(interval);
        setMessages(prev => [...prev, { role: 'assistant', text: full }]);
        setStreamText('');
        setStreaming(false);
        setShowRelevance(false);
      }
    }, 18);
  };

  const showWelcome = messages.length === 0 && !streaming;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* Messages */}
      <div ref={messagesEndRef} style={chatStyles.messages}>
        {showWelcome && <WelcomeState hasApiKey={hasApiKey} />}
        {messages.map((msg, i) => (
          msg.role === 'user'
            ? <UserMessage key={i} text={msg.text} />
            : <AssistantMessage key={i} text={msg.text} />
        ))}
        {showRelevance && !streaming && null}
        {showRelevance && <TabRelevanceBar tabs={mockTabs} />}
        {streaming && <AssistantMessage text={streamText} streaming={true} />}
      </div>

      {/* Context bar */}
      {tabCount > 0 && <ContextBar tabCount={tabCount} />}

      {/* Input */}
      <InputArea
        onSend={handleSend}
        disabled={streaming}
        researchMode={researchMode}
        onResearchToggle={() => setResearchMode(r => !r)}
      />
    </div>
  );
}

const chatStyles = {
  messages: {
    flex: 1, overflowY: 'auto',
    padding: '12px 12px 8px',
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  welcome: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', flex: 1,
    textAlign: 'center', padding: '24px 16px', gap: 8, color: '#8b8fa8',
  },
  noKeyBanner: {
    background: '#1c1510', border: '1px solid #3a2a10',
    borderRadius: 10, padding: '10px 13px',
    fontSize: 12, color: '#f59e0b', lineHeight: 1.55,
    textAlign: 'left', cursor: 'pointer', marginTop: 4,
    maxWidth: 240,
  },
  msg: { display: 'flex', gap: 8 },
  avatar: {
    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, marginTop: 1,
  },
  msgBody: { flex: 1, minWidth: 0 },
  msgRole: {
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.07em', color: '#5a5e78', marginBottom: 3,
  },
  msgText: { fontSize: 13, lineHeight: 1.6, color: '#e2e4f0', wordBreak: 'break-word' },
  inlineCode: {
    fontFamily: "'JetBrains Mono','Fira Code',monospace",
    fontSize: 11.5, background: '#222536', border: '1px solid #2c2f45',
    borderRadius: 3, padding: '1px 4px', color: '#93c5fd',
  },
  sourceChip: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 10, padding: '1px 7px', borderRadius: 20,
    background: '#1e3a6e', color: '#93c5fd',
    border: '1px solid rgba(59,130,246,0.3)',
    whiteSpace: 'nowrap', margin: '0 2px', cursor: 'pointer',
  },
  cursor: {
    display: 'inline-block', width: 2, height: 14,
    background: '#3B82F6', verticalAlign: 'text-bottom',
    animation: 'oc-blink 0.7s ease-in-out infinite', marginLeft: 1,
  },
  relevanceWrap: { animation: 'oc-fade-in 0.18s ease-out' },
  relevanceCard: {
    background: '#1a1d27', border: '1px solid #2c2f45',
    borderRadius: 6, overflow: 'hidden',
  },
  relevanceSummary: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 10px', cursor: 'pointer',
    fontSize: 11, fontWeight: 600, color: '#8b8fa8', userSelect: 'none',
  },
  relevanceCount: {
    fontSize: 10, background: '#1e3a6e', color: '#93c5fd',
    padding: '1px 5px', borderRadius: 10, fontWeight: 600,
  },
  relevanceContent: { padding: '4px 10px 8px', display: 'flex', flexDirection: 'column', gap: 3 },
  relevanceItem: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, fontSize: 11, padding: '3px 0',
    borderBottom: '1px solid rgba(44,47,69,0.4)',
  },
  relevanceTitle: {
    flex: 1, minWidth: 0, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#8b8fa8',
  },
  contextBarSummary: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '5px 12px', fontSize: 11, color: '#5a5e78',
    cursor: 'pointer', userSelect: 'none',
  },
  inputArea: {
    padding: '8px 12px 10px', background: '#1a1d27',
    borderTop: '1px solid #2c2f45', flexShrink: 0,
  },
  actionBtn: {
    background: '#222536', border: '1px solid #2c2f45',
    borderRadius: 6, color: '#5a5e78', fontFamily: 'inherit',
    fontSize: 11, padding: '4px 9px', cursor: 'pointer',
  },
  actionBtnActive: {
    background: '#1e3a6e', borderColor: '#3B82F6', color: '#93c5fd',
  },
  inputBox: {
    flex: 1, background: '#0f1117', border: '1px solid #2c2f45',
    borderRadius: 10, color: '#e2e4f0', fontFamily: 'inherit',
    fontSize: 13, lineHeight: 1.5, padding: '8px 11px',
    resize: 'none', outline: 'none', minHeight: 36, maxHeight: 150,
    overflowY: 'auto',
  },
  sendBtn: {
    width: 34, height: 34, borderRadius: 10,
    background: '#3B82F6', border: 'none', color: 'white',
    fontSize: 15, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  sendBtnDisabled: {
    background: '#2c2f45', cursor: 'not-allowed', opacity: 0.5,
  },
};

Object.assign(window, { ChatView });
