# Omni-Context Design System

## Overview

**Omni-Context** is a dark-mode Chrome Extension (Manifest v3) that lets users chat with their open browser tabs using their own AI API key. The extension reads and indexes open tab content, then lets users ask natural-language questions — with source attribution, relevance scoring, and full chat history.

**Tagline:** "Ask questions across all your open tabs using your own AI API key. 100% private — no backend."

**Version:** 3.0.0

---

## Sources

- **Codebase:** `omni-context-v3/` (attached via File System Access API)
  - `manifest.json` — Extension manifest, permissions, entry points
  - `sidepanel.html` / `sidepanel.js` — Main chat interface
  - `options.html` / `options.js` — Settings page (API key, provider, storage)
  - `styles/sidepanel.css` — Full sidepanel design tokens + component styles
  - `styles/options.css` — Options page styles (shares same token set)
  - `lib/providers.js` — 10 AI provider implementations (OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Perplexity, Cohere)
  - `lib/indexer.js` — Tab indexing + relevance scoring logic
  - `lib/marked.min.js`, `lib/highlight.core.min.js` — Markdown + syntax highlighting
  - `icons/` — icon16.png, icon48.png, icon128.png

No Figma files were provided.

---

## Products / Surfaces

1. **Sidepanel** (`sidepanel.html`) — The primary product. A narrow Chrome side panel (~360px wide, full browser height) with:
   - Header with logo, status pill, coherence pill, settings gear
   - Nav tabs: Chat / History
   - Chat view: message thread, streaming assistant responses with markdown + syntax highlighting, tab relevance expander, context bar
   - History view: searchable past sessions, expandable cards with tab restoration
   - Input area: textarea, research mode toggle, send button

2. **Options page** (`options.html`) — Settings surface. Full-tab page with:
   - Provider grid (10 AI providers)
   - API key input + model selector
   - Re-index button
   - Chat history storage management
   - Privacy note

---

## CONTENT FUNDAMENTALS

### Voice & Tone
- **Terse and technical.** No marketing fluff. Copy is functional, not promotional.
- **Developer-facing.** Assumes the user understands what an API key is, what indexing means, what a provider is.
- **Honest about scope.** The extension only answers from tab context; it explicitly refuses to hallucinate ("Ich habe keinen offenen Tab der das beantwortet").
- **Privacy-first.** Key selling point is "no backend, 100% private" — copy reflects this repeatedly.

### Language Notes
- The codebase has a German-language mix in some runtime strings (e.g. `"Gerade eben"`, `"Vor X Min"`, `"Recherche aufbauen"`, `"Verwendete Tabs"`) — suggesting the developer is German-speaking. The UI-facing copy in HTML is English; JS runtime strings are German.
- Product name: **Omni-Context** — always PascalCase, hyphenated, never "omni context" or "OmniContext".

### Casing
- UI labels: Title Case for navigation tabs ("Chat", "History"), sentence case for descriptions.
- Card section titles: ALL CAPS, tracked (`letter-spacing: 0.08em`) — e.g. "AI PROVIDER", "TAB INDEX".
- Buttons: Sentence case ("Save settings", "Test connection", "Delete all history").
- Status labels: Sentence case ("Ready", "Thinking...", "No key").

### Emoji Usage
- **Used sparingly and functionally** as inline icons within text: 🔍 (welcome state), 🔑 (API key banner), ⚙️ (settings), 💾 (context bar), ▶ (expand arrows as Unicode, not emoji).
- Emoji are NOT used decoratively on buttons or cards.
- Provider buttons use emoji as placeholder icons (🤖 OpenAI, 🧠 Anthropic, etc.) — this is a functional stand-in, not a design choice.

### Copy Examples
- Welcome: *"Ask across your tabs"* / *"Browse some pages, then ask a question."*
- Empty history: *"No chat history yet."*
- API key banner: *"API key required — Click Settings to add your OpenAI, Anthropic, or other API key to get started."*
- Privacy note: *"100% private — no backend. Your API key is stored locally…"*
- Input placeholder: *"Ask a question about your open tabs..."*

---

## VISUAL FOUNDATIONS

### Color System
All surfaces are dark. There is no light mode.

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#0f1117` | Page/panel background — deepest dark |
| `--surface` | `#1a1d27` | Cards, header, input area, history cards |
| `--surface2` | `#222536` | Elevated elements: action buttons, provider grid, input bg of inputs |
| `--border` | `#2c2f45` | All borders — subtle blue-gray tint |
| `--accent` | `#3B82F6` | Primary interactive: send button, focused inputs, active tabs, links, active chips |
| `--accent-dim` | `#1e3a6e` | Accent backgrounds: source chips bg, active action buttons bg |
| `--accent-glow` | `rgba(59,130,246,0.15)` | Focus ring glow on inputs |
| `--text` | `#e2e4f0` | Primary text — near-white with slight blue tint |
| `--text-dim` | `#8b8fa8` | Secondary text, labels, nav inactive |
| `--text-muted` | `#5a5e78` | Tertiary: timestamps, muted labels, disabled states |
| `--green` | `#22c55e` | Success states, connected status, high relevance scores |
| `--red` | `#ef4444` | Error states, destructive actions, error messages |
| `--yellow` | `#f59e0b` | Warning states, loading indicator, no-key banner, storage warnings |

**Logo gradient:** `linear-gradient(135deg, #3B82F6, #818cf8)` — blue to indigo-purple. Used on the logo tile and assistant avatar.

### Typography
- **Primary font:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` — system UI stack, no custom typeface.
- **Mono font:** `'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace` — for inline code and code blocks. Not loaded as a webfont; falls back to system mono.
- **Base size:** 13px (sidepanel), 14px (options page).
- **Line height:** 1.5 base, 1.6 for message text, 1.65 for body paragraphs.

#### Type Scale (Sidepanel)
| Role | Size | Weight | Notes |
|------|------|--------|-------|
| Header title | 13px | 600 | Letter-spacing 0.01em |
| Section label | 12px | 700 | ALL CAPS, letter-spacing 0.08em, `--text-muted` |
| Nav tab | 12px | 600 | Active: `--accent` |
| Message role | 10px | 600 | ALL CAPS, letter-spacing 0.07em, `--text-muted` |
| Message body | 13px | 400 | Line-height 1.6 |
| H1 (in markdown) | 16px | 600 | |
| H2 (in markdown) | 14px | 600 | |
| Inline code | 11.5px | 400 | JetBrains Mono, `--surface2` bg |
| Code block | 11px | 400 | Monokai theme (`#1e1e1e` bg) |
| Chips / pills | 10px | 400/600 | Rounded, 20px border-radius |
| Timestamps | 10px | 400 | `--text-muted` |
| Status text | 10px | 400 | `--text-muted` |

### Spacing System
- Base unit: **4px**. Gaps and paddings are multiples of 4 (4, 6, 8, 10, 12, 16, 20, 22, 24).
- Panel padding: `12px` horizontal.
- Card padding: `20px 22px` (options), `8px 10px` (history).
- Gap between messages: `10px`.
- Gap between header actions: `5–9px`.

### Corner Radius
- `--radius`: **10px** — used on main input box, send button, larger cards.
- `--radius-sm`: **6px** — used on action buttons, chips-like elements, code blocks, form inputs.
- Pills / status indicators: `20px` border-radius (fully rounded).
- Logo tile: `--radius-sm` (6px).
- No sharp 0px corners — even the smallest elements use 3px radius.

### Borders
- All borders use `1px solid var(--border)` — `#2c2f45`.
- No colored left-border accent patterns. Borders are uniform.
- Active/focus borders upgrade to `var(--accent)`.
- Error/warning borders use semantic colors (`#3d1515` for error, `#3a2a10` for warning, `#1a4a2a` for success).

### Shadows & Elevation
- **No box-shadow** is used for elevation — the design uses surface layering instead (`--bg` < `--surface` < `--surface2`).
- The only glow effect: `0 0 0 3px var(--accent-glow)` on focused inputs — a soft ring.
- Status dot OK state: `box-shadow: 0 0 5px var(--green)` — subtle glow on the green dot only.

### Backgrounds & Textures
- **Flat dark fills only.** No gradients on backgrounds, no textures, no images.
- The only gradient is the logo/avatar: `linear-gradient(135deg, --accent, #818cf8)`.
- Error/warning/success states use very dark tinted backgrounds (`#1c0a0a`, `#1c1510`, `#0d2014`).

### Animations
- **Minimal and fast.** Only two keyframes defined:
  - `fadeSlideIn`: 0.18s ease-out — `opacity 0 → 1`, `translateY(6px → 0)`. Used for messages and relevance sections.
  - `blink`: 0.7s ease-in-out infinite — streaming cursor blink.
  - `pulse`: 1s ease-in-out infinite — loading status dot opacity pulse.
- **Transition duration:** 0.15s for color/border/background transitions; 0.1s for transform (press).
- No bounce, no spring, no heavy motion. Easing is `ease-out` or `ease-in-out`.

### Hover States
- Icon buttons: color → `--text`, border-color → `--border`, background → `--surface2`.
- Action buttons: border-color → `--accent`, color → `--text-dim`.
- Send button: background darkens from `#3B82F6` → `#2563eb`.
- Chips: background lightens slightly.
- History delete button: color → `--red`, background → `#1c0a0a`.
- General pattern: **border highlight + slight background lift**, never opacity fade.

### Press / Active States
- Send button: `transform: scale(0.94)` — subtle physical press.
- Generic buttons: `transform: scale(0.97)`.
- No color inversion, no heavy state change.

### Scrollbars
- Custom webkit scrollbar: 4px wide, transparent track, `--border` thumb, hover → `--text-muted`.

### Cards
- Background: `--surface` (`#1a1d27`).
- Border: `1px solid var(--border)`.
- Radius: `--radius-sm` (6px) for small cards; `--radius` (10px) for settings cards.
- No shadow.
- Expandable via `<details>` + `<summary>` pattern — triangle `▶` rotates to `▼` on open.

### Transparency & Blur
- No backdrop-filter blur used anywhere.
- Transparency used for: `--accent-glow` (focus ring), border colors on semantic states, `rgba(44,47,69,0.4)` for subtle divider lines within expanded cards.

### Imagery
- No photography or illustrations.
- Logo is a procedurally generated gradient tile with a `◆` (U+25C6 / `&#9672;`) Unicode glyph as the icon mark.
- No custom SVG illustrations.

### Iconography
See ICONOGRAPHY section below.

---

## ICONOGRAPHY

### Approach
Omni-Context uses **Unicode characters and emoji** as icons — there is no dedicated icon library, no custom SVG icon set, no icon font (Lucide, Heroicons, etc.).

This is a deliberate minimalist choice consistent with Chrome extension development conventions. Icons are inline in HTML as HTML entities or Unicode codepoints.

### Key Glyphs Used
| Context | Glyph | Unicode / Entity |
|---------|-------|-----------------|
| Logo mark / Assistant avatar | ◆ | `&#9672;` / U+25C6 |
| Settings button | ⚙ | `&#9881;` / U+2699 |
| Send button | ➤ | `&#10148;` / U+27A4 |
| Context bar | 💾 | `&#128190;` |
| Welcome icon | 🔍 | `&#128269;` |
| API key banner | 🔑 | `&#128273;` |
| Research mode | 🔬 | `&#128300;` |
| Expand arrow (history, details) | ▶ | CSS `content: '▶'` |
| Collapse arrow (context bar) | ▼ | `&#9660;` |
| Re-index button | ↺ | `&#8635;` |
| Delete (close) | × | `&#215;` |
| External link (open tab) | ↗ | `&#8599;` |
| Open all | ↗ | Unicode arrow |
| Storage warning | ⚠ | `&#9888;` |
| Privacy lock | 🔒 | `&#128274;` |
| Provider: OpenAI | 🤖 | `&#129302;` |
| Provider: Anthropic | 🧠 | `&#129504;` |
| Provider: Gemini | 💡 | `&#128161;` |
| Provider: Groq | ⚡ | `&#9889;` |
| Provider: Mistral | 🌊 | `&#127754;` |
| Provider: DeepSeek | 🔎 | `&#128270;` |
| Provider: xAI | ⭐ | `&#11088;` |
| Provider: OpenRouter | 🔁 | `&#128257;` |
| Provider: Perplexity | 🔬 | `&#128300;` |
| Provider: Cohere | 🌐 | `&#127760;` |

### Icon Assets
- `assets/icon16.png` — Extension toolbar icon (16×16)
- `assets/icon48.png` — Extension management icon (48×48)
- `assets/icon128.png` — Chrome Web Store icon (128×128)

### Guidelines
- Use Unicode glyphs / HTML entities for inline UI icons — no `<img>` or `<svg>` tags for iconography.
- Keep icon sizes relative to surrounding text (set via `font-size` on parent, not explicit dimensions).
- Do not use icon fonts (Font Awesome, Material Icons, etc.) — they are not part of this design language.
- The `◆` diamond is the brand mark — use it as the product avatar/logo glyph consistently.

---

## VISUAL FOUNDATIONS (Summary)

| Property | Value |
|----------|-------|
| Color mode | Dark only |
| Background | `#0f1117` |
| Surface | `#1a1d27` / `#222536` |
| Accent | `#3B82F6` (blue) |
| Logo gradient | `135deg, #3B82F6 → #818cf8` |
| Border | `1px solid #2c2f45` |
| Radius (default) | 10px |
| Radius (small) | 6px |
| Font | System UI stack |
| Mono font | JetBrains Mono / Fira Code |
| Base size | 13px |
| Animation | 0.18s ease-out fadeSlide, 0.15s transitions |
| Elevation | Surface layering, no shadows |
| Scrollbar | 4px, `#2c2f45` thumb |

---

## File Index

```
/
├── README.md                    ← This file
├── SKILL.md                     ← Agent skill definition
├── colors_and_type.css          ← CSS custom properties (tokens + semantic)
├── assets/
│   ├── icon16.png               ← Extension toolbar icon
│   ├── icon48.png               ← Extension management icon
│   └── icon128.png              ← Chrome Web Store icon
├── preview/
│   ├── colors-base.html         ← Base color palette card
│   ├── colors-semantic.html     ← Semantic/state colors card
│   ├── type-scale.html          ← Typography scale card
│   ├── type-mono.html           ← Monospace / code type card
│   ├── spacing-tokens.html      ← Spacing + radius tokens card
│   ├── shadows-elevation.html   ← Elevation system card
│   ├── components-buttons.html  ← Button states card
│   ├── components-chips.html    ← Pills, chips, badges card
│   ├── components-inputs.html   ← Input fields card
│   ├── components-cards.html    ← Card variants card
│   ├── components-status.html   ← Status indicators card
│   ├── components-nav.html      ← Navigation tabs card
│   └── iconography.html         ← Icon glyph reference card
└── ui_kits/
    └── sidepanel/
        ├── README.md            ← Sidepanel UI kit notes
        ├── index.html           ← Interactive sidepanel prototype
        ├── Header.jsx           ← Header component
        ├── ChatView.jsx         ← Chat view with messages
        ├── HistoryView.jsx      ← History view
        ├── InputArea.jsx        ← Input area component
        └── OptionsPage.jsx      ← Settings/options page
```
