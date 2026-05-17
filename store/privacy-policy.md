# Omni-Context — Privacy Policy

**Effective Date:** May 17, 2026
**Last Updated:** May 17, 2026

## Summary

Omni-Context is a Bring Your Own Key (BYOK) Chrome extension. It collects no personal data, runs no backend, and sends no information to any server operated by the developer. All data stays in your browser.

## Data Storage

### API Keys
Your API key is stored locally in your browser using `chrome.storage.local`. It never leaves your device except when sent directly to the AI provider you selected (e.g., OpenAI, Anthropic, Google Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Perplexity, or Cohere). The developer has no access to your API key at any time.

### Tab Content
Omni-Context reads the text content of your open browser tabs to build a local search index. This index is stored exclusively in `chrome.storage.local` on your device. Tab content is never transmitted to any server other than the AI provider you chose, and only as part of the prompt context for your query.

### Chat History
Conversation history is stored locally in `chrome.storage.local`. You can view, search, and delete your chat history at any time from the extension's History tab or Settings page. No conversation data is sent to any external server.

### Settings and Preferences
Your provider selection, model choice, and UI preferences are stored in `chrome.storage.local`. None of these values are transmitted externally.

## Data Collection

Omni-Context does **not** collect, transmit, or process any of the following:

- Personal information (name, email, address, phone number)
- Browsing history beyond the current tab index
- Analytics or usage telemetry
- Crash reports
- Device identifiers or fingerprints
- Cookies for tracking purposes
- IP addresses (the extension makes no requests to developer-operated servers)

## Data Transmission

The **only** network requests Omni-Context makes are:

1. **AI Provider API calls** — When you send a chat message, the extension sends your prompt (including relevant tab content as context) directly from your browser to the API endpoint of the provider you configured (e.g., `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`). These requests are governed by the respective provider's privacy policy.

2. **Model list fetching** — When you enter an API key in Settings, the extension fetches the list of available models directly from the provider's API to populate the model selector.

No data is sent to any server owned, operated, or affiliated with the Omni-Context developer.

## Third-Party Services

When you use Omni-Context with a third-party AI provider, the content you send (your question and relevant tab text) is subject to that provider's terms of service and privacy policy. We recommend reviewing:

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

## Backend / Server Communication

Omni-Context has **no backend**. There is no server component. The extension runs entirely within your browser. The developer operates no servers that receive data from this extension.

## Permissions Explained

- **storage** — Store API keys, settings, tab index, and chat history locally.
- **tabs** — Read tab titles and URLs to build the context index.
- **activeTab** — Access the content of the currently active tab when you interact with the extension.
- **scripting** — Inject the content extraction script into web pages to read their text content.
- **sidePanel** — Display the chat interface in Chrome's Side Panel.
- **identity** — Reserved for optional OAuth login flow (currently feature-flagged and inactive).
- **host_permissions (\<all_urls\>)** — Required to extract text content from any web page you visit and to make direct API calls to AI providers.

## Data Retention

All data is stored locally and persists until you explicitly delete it or uninstall the extension. You can delete your chat history at any time via the Settings page. Uninstalling the extension removes all stored data.

## Children's Privacy

Omni-Context does not knowingly collect information from children under 13. The extension requires an API key from a third-party provider, which typically requires the user to be at least 18 years old.

## Changes to This Policy

Updates to this privacy policy will be posted on the Chrome Web Store listing and in the extension's repository. The "Last Updated" date at the top will be revised accordingly.

## Contact

If you have questions about this privacy policy, contact:

**Email:** [vizionsupport@gmail.com]
**GitHub:** [https://github.com/your-username/omni-context]
