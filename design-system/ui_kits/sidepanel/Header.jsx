// Header.jsx — Omni-Context sidepanel header component

function Header({ statusState = 'ok', coherenceTopic = null, coherenceScore = null, onSettingsClick }) {
  const statusLabels = { ok: 'Ready', loading: 'Thinking...', error: 'Error', none: 'No key' };
  const statusLabel = statusLabels[statusState] || 'No key';

  return (
    <header style={headerStyles.header}>
      <div style={headerStyles.logo}>◆</div>
      <span style={headerStyles.title}>Omni-Context</span>
      <div style={headerStyles.actions}>
        {coherenceTopic && coherenceScore !== null && (
          <div style={headerStyles.coherencePill} title={`Tab coherence: ${coherenceScore}%`}>
            🎯 {coherenceTopic} · {coherenceScore}%
          </div>
        )}
        <div style={headerStyles.statusPill}>
          <div style={{
            ...headerStyles.statusDot,
            background: statusState === 'ok' ? '#22c55e'
              : statusState === 'loading' ? '#f59e0b'
              : statusState === 'error' ? '#ef4444'
              : '#5a5e78',
            boxShadow: statusState === 'ok' ? '0 0 5px #22c55e' : 'none',
          }} />
          <span>{statusLabel}</span>
        </div>
        <button style={headerStyles.iconBtn} onClick={onSettingsClick} title="Settings">⚙</button>
      </div>
    </header>
  );
}

const headerStyles = {
  header: {
    display: 'flex', alignItems: 'center', gap: 9,
    padding: '10px 12px 9px',
    background: '#1a1d27',
    borderBottom: '1px solid #2c2f45',
    flexShrink: 0,
  },
  logo: {
    width: 22, height: 22,
    background: 'linear-gradient(135deg, #3B82F6, #818cf8)',
    borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, color: 'white', flexShrink: 0,
  },
  title: {
    fontSize: 13, fontWeight: 600, letterSpacing: '0.01em', flex: 1, color: '#e2e4f0',
  },
  actions: {
    display: 'flex', alignItems: 'center', gap: 5, minWidth: 0,
  },
  coherencePill: {
    fontSize: 10, color: '#8b8fa8',
    padding: '2px 7px', borderRadius: 20,
    background: '#222536', border: '1px solid #2c2f45',
    whiteSpace: 'nowrap', flexShrink: 1,
    maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis',
  },
  statusPill: {
    display: 'flex', alignItems: 'center', gap: 4,
    fontSize: 10, color: '#5a5e78',
    padding: '2px 7px', borderRadius: 20,
    background: '#222536', border: '1px solid #2c2f45',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  statusDot: {
    width: 6, height: 6, borderRadius: '50%', flexShrink: 0, transition: 'background 0.3s',
  },
  iconBtn: {
    background: 'none', border: '1px solid transparent',
    borderRadius: 6, color: '#8b8fa8', cursor: 'pointer',
    padding: '3px 5px', fontSize: 14, lineHeight: 1,
    transition: 'color 0.15s, border-color 0.15s, background 0.15s',
    flexShrink: 0,
  },
};

Object.assign(window, { Header });
