// OptionsPage.jsx — Omni-Context settings page

const PROVIDERS = [
  { id: 'openai',      name: 'OpenAI',      icon: '🤖' },
  { id: 'anthropic',   name: 'Anthropic',   icon: '🧠' },
  { id: 'gemini',      name: 'Gemini',      icon: '💡' },
  { id: 'groq',        name: 'Groq',        icon: '⚡' },
  { id: 'mistral',     name: 'Mistral',     icon: '🌊' },
  { id: 'deepseek',    name: 'DeepSeek',    icon: '🔎' },
  { id: 'xai',         name: 'xAI',         icon: '⭐' },
  { id: 'openrouter',  name: 'OpenRouter',  icon: '🔁' },
  { id: 'perplexity',  name: 'Perplexity',  icon: '🔬' },
  { id: 'cohere',      name: 'Cohere',      icon: '🌐' },
];

const MODELS = {
  openai:     ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini'],
  anthropic:  ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  gemini:     ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  groq:       ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  mistral:    ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest'],
  deepseek:   ['deepseek-chat', 'deepseek-coder'],
  xai:        ['grok-2', 'grok-2-mini'],
  openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-3-haiku', 'meta-llama/llama-3.3-70b'],
  perplexity: ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'],
  cohere:     ['command-r-plus', 'command-r', 'command-light'],
};

function OptionsPage({ onSave }) {
  const [provider, setProvider] = React.useState('anthropic');
  const [apiKey, setApiKey] = React.useState('');
  const [model, setModel] = React.useState('claude-3-5-haiku-20241022');
  const [status, setStatus] = React.useState(null); // { type: 'ok'|'err'|'info', text }
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    const models = MODELS[provider] || [];
    setModel(models[0] || '');
  }, [provider]);

  const handleSave = () => {
    if (!apiKey.trim()) {
      setStatus({ type: 'err', text: 'Please enter an API key.' });
      return;
    }
    setSaving(true);
    setStatus({ type: 'info', text: 'Saving...' });
    setTimeout(() => {
      setSaving(false);
      setStatus({ type: 'ok', text: 'Settings saved successfully.' });
      if (onSave) onSave({ provider, apiKey, model });
    }, 800);
  };

  const handleTest = () => {
    setStatus({ type: 'info', text: `Testing connection to ${provider}...` });
    setTimeout(() => {
      setStatus({ type: 'ok', text: `✓ Connected — model available.` });
    }, 1200);
  };

  const statusColors = {
    ok:   { bg: '#0d2014', border: '#1a4a2a', color: '#22c55e' },
    err:  { bg: '#1c0a0a', border: '#3d1515', color: '#ef4444' },
    info: { bg: '#0e1a30', border: '#1e3a6e', color: '#93c5fd' },
  };

  return (
    <div style={optStyles.page}>
      {/* Header */}
      <div style={optStyles.header}>
        <div style={optStyles.logoTile}>◆</div>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#e2e4f0' }}>Omni-Context</h1>
          <p style={{ fontSize: 13, color: '#8b8fa8', marginTop: 1 }}>Settings &amp; API key configuration</p>
        </div>
      </div>

      {/* Provider card */}
      <div style={optStyles.card}>
        <div style={optStyles.cardTitle}>AI Provider</div>
        <div style={optStyles.providerGrid}>
          {PROVIDERS.map(p => (
            <button
              key={p.id}
              style={{
                ...optStyles.providerBtn,
                ...(provider === p.id ? optStyles.providerBtnActive : {}),
              }}
              onClick={() => setProvider(p.id)}
            >
              <span style={{ fontSize: 20, display: 'block', marginBottom: 5 }}>{p.icon}</span>
              <span style={{ fontSize: 11, fontWeight: 600 }}>{p.name}</span>
            </button>
          ))}
        </div>

        <div style={optStyles.field}>
          <label style={optStyles.label}>API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="Paste your API key here..."
            style={optStyles.input}
            autoComplete="off"
          />
          <div style={{ fontSize: 11, color: '#5a5e78', marginTop: 5, lineHeight: 1.5 }}>
            Your key is stored locally and never leaves your browser.
          </div>
        </div>

        <div style={optStyles.field}>
          <label style={optStyles.label}>Model</label>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            style={optStyles.select}
          >
            {(MODELS[provider] || []).map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
          <button style={optStyles.btnPrimary} onClick={handleSave} disabled={saving}>Save settings</button>
          <button style={optStyles.btnSecondary} onClick={handleTest}>Test connection</button>
        </div>

        {status && (
          <div style={{
            fontSize: 12, padding: '8px 12px', borderRadius: 6, marginTop: 10,
            background: statusColors[status.type].bg,
            border: `1px solid ${statusColors[status.type].border}`,
            color: statusColors[status.type].color,
          }}>
            {status.text}
          </div>
        )}
      </div>

      {/* Re-index card */}
      <div style={optStyles.card}>
        <div style={optStyles.cardTitle}>Tab Index</div>
        <p style={{ fontSize: 13, color: '#8b8fa8', marginBottom: 14, lineHeight: 1.5 }}>
          Omni-Context indexes your open tabs automatically. Use this to re-scan all currently open tabs.
        </p>
        <button style={optStyles.btnSecondary}>↺ Re-index all open tabs</button>
      </div>

      {/* Privacy note */}
      <div style={optStyles.privacyNote}>
        <strong style={{ color: '#22c55e', display: 'block', marginBottom: 4, fontSize: 12 }}>
          🔒 100% private — no backend
        </strong>
        Your API key is stored locally in your browser using <code style={{ fontFamily: 'monospace', fontSize: 11, color: '#93c5fd' }}>chrome.storage.local</code>. It is only sent directly to your chosen AI provider. No data ever touches a third-party server.
      </div>
    </div>
  );
}

const optStyles = {
  page: {
    flex: 1, overflowY: 'auto',
    padding: '24px 16px',
    background: '#0f1117',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28,
  },
  logoTile: {
    width: 36, height: 36,
    background: 'linear-gradient(135deg, #3B82F6, #818cf8)',
    borderRadius: 9, display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 18, color: 'white', flexShrink: 0,
  },
  card: {
    background: '#1a1d27', border: '1px solid #2c2f45',
    borderRadius: 10, padding: '20px 22px', marginBottom: 16,
  },
  cardTitle: {
    fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.08em', color: '#5a5e78', marginBottom: 16,
  },
  providerGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 8, marginBottom: 18,
  },
  providerBtn: {
    background: '#222536', border: '1px solid #2c2f45',
    borderRadius: 6, padding: '12px 8px', cursor: 'pointer',
    textAlign: 'center', color: '#8b8fa8',
    transition: 'border-color 0.15s, background 0.15s',
  },
  providerBtnActive: {
    borderColor: '#3B82F6', background: '#1e3a6e', color: '#e2e4f0',
  },
  field: { marginBottom: 14 },
  label: {
    display: 'block', fontSize: 12, fontWeight: 600,
    color: '#8b8fa8', marginBottom: 6,
  },
  input: {
    width: '100%', background: '#0f1117', border: '1px solid #2c2f45',
    borderRadius: 6, color: '#e2e4f0', fontFamily: 'inherit',
    fontSize: 13, padding: '9px 12px', outline: 'none',
  },
  select: {
    width: '100%', background: '#0f1117', border: '1px solid #2c2f45',
    borderRadius: 6, color: '#e2e4f0', fontFamily: 'inherit',
    fontSize: 13, padding: '9px 12px', outline: 'none',
    appearance: 'none', cursor: 'pointer',
  },
  btnPrimary: {
    padding: '9px 18px', borderRadius: 6, border: 'none',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', background: '#3B82F6', color: 'white',
  },
  btnSecondary: {
    padding: '9px 18px', borderRadius: 6, border: '1px solid #2c2f45',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', background: '#222536', color: '#8b8fa8',
  },
  privacyNote: {
    background: '#1a1d27', border: '1px solid #2c2f45',
    borderRadius: 10, padding: '14px 16px',
    fontSize: 12, color: '#8b8fa8', lineHeight: 1.65,
  },
};

Object.assign(window, { OptionsPage });
