# Changelog

All notable changes to Omni-Context will be documented in this file.

## [Unreleased]

### Added
- Static Cloudflare Pages landing site for `omni.anpalahan.org` with hero, Chrome Web Store badge, feature grid, pricing, privacy proof panel, and demo GIF placeholder.
- Landing page assets copied from the extension icon and current store screenshots.

## [3.5.0] — 2026-06-24

### Added
- Semantic search with provider embeddings for better tab relevance scoring
- PDF export via browser print dialog
- Google Drive backup integration for settings sync
- Error logging system for debugging

### Fixed
- EXCLUDE_DOMAIN error handling + safe Map iteration in service worker
- ExtPay mock in integration tests
- Chunk count validation in settings sync

### Security
- Validate fileId format before URL interpolation in Google Drive backup
- Upper bound validation for sync chunk counts

### Docs
- JSDoc added to sidepanel helper functions
- JSDoc added to settings helper functions

## [3.4.0] — 2026-06-20

### Added
- ExtensionPay monetization integration
- 10 AI providers (OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Perplexity, Cohere)
- Research mode for systematic tab-by-tab analysis
- Compare mode for comparing content across tabs
- Mermaid diagram rendering in chat
- Tab Group integration with Chrome Tab Groups
- Follow-up question suggestions
- Markdown export for conversations
- Auto-indexing with 60-second refresh
- Source action menu (open, dive deeper, compare, find missing info)
- Onboarding flow for new users
- i18n support (English, German)
- Dark/Light theme with system detection

## [3.0.0] — 2026-05-17

### Added
- Initial Chrome Web Store preparation
- Privacy policy
- BYOK (Bring Your Own Key) architecture
- Side Panel UI
- TF-IDF relevance scoring
- Source citations with clickable chips
- Chat history with local storage
- PDF content extraction in service worker
