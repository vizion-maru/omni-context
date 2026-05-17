# Omni-Context — Datenschutzerklärung

**Gültig ab:** 17. Mai 2026
**Zuletzt aktualisiert:** 17. Mai 2026

## Zusammenfassung

Omni-Context ist eine Bring-Your-Own-Key-Erweiterung (BYOK) für Chrome. Sie erfasst keine personenbezogenen Daten, betreibt kein Backend und sendet keine Informationen an einen Server des Entwicklers. Alle Daten verbleiben in deinem Browser.

## Datenspeicherung

### API-Schlüssel
Dein API-Schlüssel wird lokal in deinem Browser mittels `chrome.storage.local` gespeichert. Er verlässt dein Gerät ausschließlich, wenn er direkt an den von dir gewählten KI-Anbieter gesendet wird (z. B. OpenAI, Anthropic, Google Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Perplexity oder Cohere). Der Entwickler hat zu keinem Zeitpunkt Zugriff auf deinen API-Schlüssel.

### Tab-Inhalte
Omni-Context liest den Textinhalt deiner offenen Browser-Tabs, um einen lokalen Suchindex aufzubauen. Dieser Index wird ausschließlich in `chrome.storage.local` auf deinem Gerät gespeichert. Tab-Inhalte werden an keinen anderen Server als den von dir gewählten KI-Anbieter übertragen — und auch nur als Teil des Prompt-Kontexts für deine Anfrage.

### Chat-Verlauf
Der Gesprächsverlauf wird lokal in `chrome.storage.local` gespeichert. Du kannst deinen Chat-Verlauf jederzeit über den History-Tab oder die Einstellungsseite einsehen, durchsuchen und löschen. Keine Gesprächsdaten werden an externe Server gesendet.

### Einstellungen und Präferenzen
Deine Anbieterauswahl, Modellwahl und UI-Einstellungen werden in `chrome.storage.local` gespeichert. Keiner dieser Werte wird nach außen übertragen.

## Datenerfassung

Omni-Context erfasst, überträgt oder verarbeitet **keine** der folgenden Daten:

- Personenbezogene Daten (Name, E-Mail, Adresse, Telefonnummer)
- Browserverlauf über den aktuellen Tab-Index hinaus
- Analyse- oder Nutzungstelemetrie
- Absturzberichte
- Gerätekennungen oder Fingerprints
- Cookies zu Tracking-Zwecken
- IP-Adressen (die Erweiterung stellt keine Anfragen an vom Entwickler betriebene Server)

## Datenübertragung

Die **einzigen** Netzwerkanfragen, die Omni-Context stellt, sind:

1. **KI-Anbieter-API-Aufrufe** — Wenn du eine Chat-Nachricht sendest, schickt die Erweiterung deinen Prompt (einschließlich relevanter Tab-Inhalte als Kontext) direkt von deinem Browser an den API-Endpunkt des von dir konfigurierten Anbieters (z. B. `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`). Diese Anfragen unterliegen der jeweiligen Datenschutzrichtlinie des Anbieters.

2. **Modelllisten-Abruf** — Wenn du in den Einstellungen einen API-Schlüssel eingibst, ruft die Erweiterung die Liste verfügbarer Modelle direkt von der API des Anbieters ab, um die Modellauswahl zu befüllen.

Es werden keine Daten an einen Server gesendet, der dem Omni-Context-Entwickler gehört, von ihm betrieben wird oder mit ihm verbunden ist.

## Drittanbieter-Dienste

Wenn du Omni-Context mit einem KI-Drittanbieter nutzt, unterliegen die von dir gesendeten Inhalte (deine Frage und relevanter Tab-Text) den Nutzungsbedingungen und der Datenschutzrichtlinie des jeweiligen Anbieters. Wir empfehlen die Lektüre von:

- OpenAI: https://openai.com/policies/privacy-policy
- Anthropic: https://www.anthropic.com/privacy
- Google (Gemini): https://ai.google.dev/terms
- Groq: https://groq.com/privacy-policy
- Mistral: https://mistral.ai/terms
- DeepSeek: https://www.deepseek.com/privacy
- xAI: https://x.ai/legal/privacy-policy
- OpenRouter: https://openrouter.ai/privacy
- Perplexity: https://www.perplexity.ai/privacy
- Cohere: https://cohere.com/privacy

## Backend / Serverkommunikation

Omni-Context hat **kein Backend**. Es gibt keine Serverkomponente. Die Erweiterung läuft vollständig innerhalb deines Browsers. Der Entwickler betreibt keine Server, die Daten von dieser Erweiterung empfangen.

## Berechtigungen erklärt

- **storage** — Lokale Speicherung von API-Schlüsseln, Einstellungen, Tab-Index und Chat-Verlauf.
- **tabs** — Lesen von Tab-Titeln und URLs zum Aufbau des Kontext-Index.
- **activeTab** — Zugriff auf den Inhalt des aktuell aktiven Tabs bei Interaktion mit der Erweiterung.
- **scripting** — Einfügen des Content-Extraction-Skripts in Webseiten zum Lesen des Textinhalts.
- **sidePanel** — Anzeige der Chat-Oberfläche im Chrome Side Panel.
- **identity** — Reserviert für optionalen OAuth-Login-Flow (derzeit per Feature-Flag deaktiviert).
- **host_permissions (\<all_urls\>)** — Erforderlich, um Textinhalte von beliebigen Webseiten zu extrahieren und direkte API-Aufrufe an KI-Anbieter zu tätigen.

## Datenspeicherdauer

Alle Daten werden lokal gespeichert und bleiben bestehen, bis du sie ausdrücklich löschst oder die Erweiterung deinstallierst. Du kannst deinen Chat-Verlauf jederzeit über die Einstellungsseite löschen. Die Deinstallation der Erweiterung entfernt alle gespeicherten Daten.

## Datenschutz für Kinder

Omni-Context erfasst wissentlich keine Daten von Kindern unter 13 Jahren. Die Erweiterung erfordert einen API-Schlüssel eines Drittanbieters, der in der Regel ein Mindestalter von 18 Jahren voraussetzt.

## Änderungen dieser Richtlinie

Aktualisierungen dieser Datenschutzerklärung werden im Chrome Web Store-Eintrag und im Repository der Erweiterung veröffentlicht. Das Datum „Zuletzt aktualisiert" oben wird entsprechend angepasst.

## Kontakt

Bei Fragen zu dieser Datenschutzerklärung:

**E-Mail:** [your-email@example.com]
**GitHub:** [https://github.com/your-username/omni-context]
