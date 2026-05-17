# Omni-Context Sidepanel UI Kit

## Overview
High-fidelity recreation of the Omni-Context Chrome Extension sidepanel (~360px wide).

## Screens
1. **Chat (Welcome state)** — No messages yet, API key missing
2. **Chat (Active)** — Streaming response, source chips, tab relevance, context bar
3. **Chat (Research mode)** — Research toggle active
4. **History** — Searchable past sessions, expandable cards

## Components
- `Header.jsx` — Logo, title, coherence pill, status pill, settings button
- `ChatView.jsx` — Messages, welcome state, tab relevance, context bar, input area
- `HistoryView.jsx` — History toolbar + list of expandable session cards
- `OptionsPage.jsx` — Settings page (provider grid, API key, model select)

## Notes
- All widths are fixed at 360px to match Chrome side panel dimensions
- Font stack: system-ui (no custom webfonts loaded)
- Icons: Unicode glyphs only, no icon library
- Prototype uses simulated streaming via setInterval
