# Omni-Context — Screenshot-Plan für Chrome Web Store

## Chrome Web Store Anforderungen

- **Anzahl:** 1–5 Screenshots (min. 1, max. 5)
- **Auflösung:** 1280×800 px oder 640×400 px (empfohlen: 1280×800)
- **Format:** PNG oder JPEG
- **Sprache:** Englisch (primäres Listing), optional deutsch für lokalisiertes Listing

## SEO-Keywords für Alt-Texte

browser context, tab manager, AI assistant, chrome side panel, BYOK AI, private AI extension, chat with tabs, research assistant, browser tab context

## Screenshot 1: Side Panel Chat in Aktion (Pflicht — Hauptbild)

**Was zeigen:**
Chrome-Browser mit 4–6 geöffneten Tabs (z. B. Wikipedia, ArXiv-Paper, News-Artikel, GitHub). Rechts das Omni-Context Side Panel mit:
- Header mit Logo, Status-Pill "Ready" (grüner Dot)
- Kohärenz-Badge sichtbar (z. B. "AI Research · 78%")
- Context-Bar ausgeklappt: "Using 5 indexed tabs as context" mit Tab-Liste und Relevanz-Scores
- Ein User-Prompt: "What are the main differences between transformer and diffusion architectures?"
- Eine AI-Antwort mit Fließtext, die Quellen-Chips enthält (z. B. [Tab: Attention Is All You Need], [Tab: Denoising Diffusion...])
- Follow-up-Vorschläge als Chips unter der Antwort

**Zweck:** Zeigt den Kernwert — Fragen über alle Tabs stellen, Antwort mit Quellenangaben.

**Annotation (Overlay-Text):**
"Ask questions across all your tabs" (oben, groß)
"AI answers with source citations" (unten, klein)

**Store-Alt-Text / Beschreibung:**
Ask a question across all open Chrome tabs and get an AI answer with clickable source citations. Browser context and AI assistant in the Chrome side panel.

## Screenshot 2: Provider-Auswahl (10 Provider)

**Was zeigen:**
Die Options-Seite (`options.html`) mit:
- Provider-Grid: alle 10 Buttons sichtbar (OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Perplexity, Cohere)
- Ein Provider ausgewählt (z. B. Anthropic, blau hervorgehoben)
- API-Key-Feld (mit Placeholder `sk-ant-...`)
- Modell-Dropdown geöffnet mit 3–4 Modellen (z. B. claude-sonnet-4, claude-3-5-haiku)
- Model-Indicator: "✓ 6 models loaded"
- Privacy-Note unten sichtbar: "100% private — no backend"

**Zweck:** Zeigt die Breite der Provider-Unterstützung und BYOK-Prinzip.

**Annotation:**
"10 AI providers — bring your own key"
"Your key stays in your browser"

**Store-Alt-Text / Beschreibung:**
Choose from 10 AI providers with your own API key. BYOK tab manager: your key stays local in the browser, no backend.

## Screenshot 3: Recherche-Modus + Relevanz-Scoring

**Was zeigen:**
Side Panel mit aktiviertem Recherche-Modus:
- Research-Button aktiv/hervorgehoben ("Recherche aufbauen" aktiv)
- Input-Placeholder zeigt "Research question: all tabs will be analyzed systematically..."
- Über der Antwort: ausgeklapptes Relevanz-Panel "Verwendete Tabs" mit 4–5 Tabs und Prozent-Scores (z. B. "Wikipedia: Transformer · 92%", "ArXiv Paper · 85%", "Blog Post · 34%")
- Unter dem Relevanz-Panel: "2 nicht relevante Tabs" (eingeklappt)
- AI-Antwort mit strukturierter Analyse (Bullet Points, Vergleichstabelle)

**Zweck:** Zeigt den Recherche-Modus und die Transparenz der Relevanz-Bewertung.

**Annotation:**
"Research mode: systematic tab-by-tab analysis"
"See which tabs were used and why"

**Store-Alt-Text / Beschreibung:**
Research mode gives systematic tab-by-tab analysis and shows relevance scores for every source in your browser context.

## Screenshot 4: Chat-Verlauf + Mermaid-Diagramm

**Was zeigen:**
Zwei Bereiche, gesplittet oder als Overlay:

**Obere Hälfte — Mermaid-Diagramm:**
- Eine AI-Antwort im Chat, die ein gerendertes Mermaid-Diagramm enthält (z. B. ein Flowchart oder Mindmap zu einem Thema)
- Diagramm-Toggle-Button "📊 Diagram" sichtbar
- Klickbare Knoten im Diagramm

**Untere Hälfte — History-View:**
- Nav-Tabs: "Chat" und "History" (History aktiv)
- History-Suche mit Suchfeld
- 3–4 History-Cards mit Zeitstempel ("Vor 2 Std", "Gestern"), Preview-Text und Model-Badges (z. B. "gpt-4o", "claude-sonnet-4")
- Ein Card ausgeklappt mit Nachrichten-Preview und Tab-Liste mit "Open all"-Button

**Zweck:** Zeigt erweiterte Features — Diagramme und persistenten Verlauf.

**Annotation:**
"AI-generated diagrams rendered in chat"
"Full conversation history with search"

**Store-Alt-Text / Beschreibung:**
AI-generated Mermaid diagrams render in chat and every conversation is saved to a searchable local history.

## Screenshot 5: Tab-Gruppen + Quellen-Aktionsmenü

**Was zeigen:**
Side Panel mit zwei Features gleichzeitig:

**Context-Bar ausgeklappt mit Tab-Gruppen:**
- Tab Groups-Sektion sichtbar: "Tab Groups" Label
- 2–3 Gruppen mit farbigen Dots (z. B. blau "ML Research (4)", grün "Docs (3)")
- "Summarize"-Button neben jeder Gruppe
- Darunter: einzelne Tabs mit Relevanz-Scores

**Quellen-Aktionsmenü (Overlay):**
- Ein Source-Chip in der Antwort ist rechts-geklickt
- Kontextmenü sichtbar mit 4 Optionen:
  - "🔗 Go to tab"
  - "🔍 Dive deeper"
  - "⚖️ Compare with..."
  - "❓ What is missing?"

**Zweck:** Zeigt die tiefe Chrome-Integration (Tab Groups) und die interaktiven Quellen-Features.

**Annotation:**
"Chrome Tab Groups integration"
"Right-click sources to dive deeper"

**Store-Alt-Text / Beschreibung:**
Chrome Tab Groups integration and right-click source actions help you manage browser context and dive deeper into any answer.

## Erstellung der Screenshots

### Vorbereitung

1. Chrome auf 1280×800 Viewport einstellen (DevTools → Device Toolbar oder Window-Resize)
2. Dark Theme der Extension nutzen (Standard)
3. Realistische Tab-Inhalte vorbereiten (keine Lorem-Ipsum-Texte)
4. API-Key konfigurieren und echte Antworten generieren
5. Annotations als Overlay in Figma, Canva oder ähnlichem Tool hinzufügen

### Annotation-Style

- Schriftart: Inter oder System-Font (clean, modern)
- Hintergrund: semi-transparenter dunkler Balken oder Gradient am oberen/unteren Rand
- Textfarbe: Weiß
- Keine Pfeile oder Callout-Bubbles — die UI soll für sich sprechen
- Max. 2 Zeilen Text pro Screenshot

### Reihenfolge im Store

1. Side Panel Chat (Hero-Shot) — das sieht der Nutzer zuerst
2. Provider-Auswahl — BYOK + 10 Provider als Differenzierungsmerkmal
3. Recherche-Modus — für Power-User und Researcher
4. Verlauf + Diagramme — erweiterte Features
5. Tab-Gruppen + Aktionsmenü — Chrome-native Integration
