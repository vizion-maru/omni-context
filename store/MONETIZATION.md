# Omni-Context — Freemium Monetization Strategy

## Pricing Tiers

### FREE

| Feature | Limit |
|---|---|
| AI Provider | OpenRouter, Groq, Gemini (3 von 10) |
| Tab-Indexierung | Max. 10 Tabs |
| Chat | Basic Chat (Side Panel) |
| Chat-Verlauf | Einsehbar, nicht exportierbar |
| Modellauswahl | Eingeschränkt auf Free-Provider |
| Quellenangaben | Ja |
| Relevanz-Scoring | Ja |
| Follow-up-Vorschläge | Ja |

**Warum diese 3 Provider gratis?**
- **OpenRouter** — Meta-Provider mit Zugang zu vielen Modellen, auch kostenlosen (Llama, Gemma). Niedrige Einstiegshürde.
- **Groq** — Schnellster Inference-Provider, kostenlose Tier verfügbar. Sofortiges Erfolgserlebnis.
- **Gemini** — Google AI Studio bietet großzügige Free-Tiers. Breite Nutzerbasis.

### PRO — $4.99 Einmalkauf (Chrome Web Store Payment)

| Feature | Details |
|---|---|
| AI Provider | Alle 10 (+ OpenAI, Anthropic, Mistral, DeepSeek, xAI, Perplexity, Cohere) |
| Tab-Indexierung | Unbegrenzt |
| Chat History Export | Markdown-Export aller Gespräche |
| Custom System Prompts | Eigene System-Prompts definieren |
| Prompt Templates | Vorgefertigte und eigene Prompt-Vorlagen |
| Tab-Gruppen-Filter | Chat auf bestimmte Tab-Gruppen einschränken |
| Recherche-Modus | Systematische Tab-für-Tab-Analyse |
| Prioritäts-Support | GitHub Issues mit Priority-Label |

## Technische Implementierung

### 1. Lizenz-Flag in chrome.storage

```javascript
// Lizenzstatus prüfen und cachen
// chrome.storage.local keys:
// - license_status: "free" | "pro"
// - license_purchased_at: ISO timestamp
// - license_receipt_token: Chrome Web Store receipt token

async function getLicenseStatus() {
  const { license_status } = await chrome.storage.local.get('license_status');
  return license_status || 'free';
}

async function activatePro(receiptToken) {
  await chrome.storage.local.set({
    license_status: 'pro',
    license_purchased_at: new Date().toISOString(),
    license_receipt_token: receiptToken
  });
}
```

### 2. Chrome Web Store Licensing API

Chrome Web Store stellt eine Licensing API bereit, die den Kaufstatus über `chrome.identity` verifiziert:

```javascript
// background.js — Lizenz beim Start prüfen
async function verifyLicense() {
  try {
    // Chrome Web Store Payments API (One-Time Payment)
    // https://developer.chrome.com/docs/webstore/one_time_payments/
    const response = await fetch(
      `https://www.googleapis.com/chromewebstore/v1.1/userlicenses/${chrome.runtime.id}`,
      {
        headers: {
          Authorization: `Bearer ${await getOAuthToken()}`
        }
      }
    );
    const license = await response.json();

    if (license.result && license.accessLevel === 'FULL') {
      await chrome.storage.local.set({ license_status: 'pro' });
      return 'pro';
    } else {
      await chrome.storage.local.set({ license_status: 'free' });
      return 'free';
    }
  } catch (err) {
    // Offline-Fallback: cached license_status verwenden
    const { license_status } = await chrome.storage.local.get('license_status');
    return license_status || 'free';
  }
}

// Bei Extension-Start und periodisch (alle 24h)
chrome.runtime.onStartup.addListener(() => verifyLicense());
setInterval(() => verifyLicense(), 24 * 60 * 60 * 1000);
```

**Hinweis:** Die Chrome Web Store Payments API wurde deprecated. Alternative Ansätze:

- **Option A: ExtensionPay (extpay.js)** — Drittanbieter-Service für Extension-Payments. Einfache Integration, $0 setup, 5% fee.
- **Option B: Eigener License-Server** — Stripe/LemonSqueezy + minimaler Verification-Endpoint. License-Key wird in `chrome.storage.local` gespeichert.
- **Option C: Chrome Web Store In-App Payments (falls wieder verfügbar)** — Google arbeitet an einer neuen Payment-API für Extensions.

Empfehlung: **ExtensionPay** als pragmatischste Lösung. Kein eigener Server nötig, BYOK-Prinzip bleibt gewahrt (Payment-Verification ist der einzige externe Call).

### 3. Feature Gates in JavaScript

```javascript
// lib/feature-gates.js

const PRO_PROVIDERS = ['openai', 'anthropic', 'mistral', 'deepseek', 'xai', 'perplexity', 'cohere'];
const FREE_PROVIDERS = ['openrouter', 'groq', 'gemini'];
const FREE_TAB_LIMIT = 10;

export class FeatureGate {
  constructor() {
    this._status = 'free';
    this._loaded = this._load();
  }

  async _load() {
    const { license_status } = await chrome.storage.local.get('license_status');
    this._status = license_status || 'free';
  }

  async ready() {
    await this._loaded;
  }

  get isPro() {
    return this._status === 'pro';
  }

  // Provider-Gate: Ist dieser Provider verfügbar?
  isProviderAvailable(providerId) {
    if (this.isPro) return true;
    return FREE_PROVIDERS.includes(providerId);
  }

  // Tab-Limit-Gate: Dürfen weitere Tabs indexiert werden?
  canIndexMoreTabs(currentCount) {
    if (this.isPro) return true;
    return currentCount < FREE_TAB_LIMIT;
  }

  // Export-Gate
  canExport() {
    return this.isPro;
  }

  // Custom System Prompt Gate
  canUseCustomSystemPrompt() {
    return this.isPro;
  }

  // Prompt Templates Gate
  canUsePromptTemplates() {
    return this.isPro;
  }

  // Tab-Gruppen-Filter Gate
  canFilterByTabGroup() {
    return this.isPro;
  }

  // Research Mode Gate
  canUseResearchMode() {
    return this.isPro;
  }
}

export const gate = new FeatureGate();
```

### 4. Integration in bestehenden Code

#### options.js — Provider-Buttons gaten

```javascript
// Provider-Grid: Pro-Provider mit Lock-Icon versehen
import { gate } from './lib/feature-gates.js';

await gate.ready();

providerBtns.forEach(btn => {
  const provider = btn.dataset.provider;
  if (!gate.isProviderAvailable(provider)) {
    btn.classList.add('locked');
    btn.querySelector('.provider-name').textContent += ' (Pro)';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      showUpgradePrompt();
    });
  }
});
```

#### background.js — Tab-Limit durchsetzen

```javascript
import { gate } from './lib/feature-gates.js';

// In extractAndIndex():
async function extractAndIndex(tabId) {
  await gate.ready();
  if (!gate.canIndexMoreTabs(indexer.size())) {
    return; // Free-Limit erreicht, nicht indexieren
  }
  // ... bestehender Code
}
```

#### sidepanel.js — Export und Features gaten

```javascript
import { gate } from './lib/feature-gates.js';

// Export-Button nur für Pro
if (!gate.canExport()) {
  exportBtn.classList.add('locked');
  exportBtn.title = 'Export (Pro feature)';
}

// Research-Button nur für Pro
if (!gate.canUseResearchMode()) {
  researchBtn.classList.add('locked');
  researchBtn.title = 'Research mode (Pro feature)';
}
```

### 5. Upgrade-Prompt UI

```javascript
function showUpgradePrompt() {
  const modal = document.createElement('div');
  modal.className = 'upgrade-modal';
  modal.innerHTML = `
    <div class="upgrade-content">
      <h3>Upgrade to Pro</h3>
      <p>Unlock all 10 AI providers, unlimited tabs, export, custom prompts, and more.</p>
      <ul>
        <li>All 10 AI providers (OpenAI, Anthropic, Mistral, ...)</li>
        <li>Unlimited tab indexing</li>
        <li>Markdown export</li>
        <li>Custom system prompts</li>
        <li>Prompt templates</li>
        <li>Tab group filtering</li>
      </ul>
      <div class="upgrade-price">$4.99 one-time</div>
      <button class="btn btn-primary" id="upgrade-buy-btn">Upgrade Now</button>
      <button class="btn btn-secondary" id="upgrade-close-btn">Maybe Later</button>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#upgrade-close-btn').addEventListener('click', () => modal.remove());
  modal.querySelector('#upgrade-buy-btn').addEventListener('click', () => {
    // Trigger ExtensionPay oder Chrome Web Store Payment
    initiatePayment();
  });
}
```

### 6. Dateistruktur-Änderungen

```
extension/
  lib/
    feature-gates.js    ← NEU: Feature-Gate-Logik
  styles/
    upgrade-modal.css   ← NEU: Upgrade-Modal-Styles
```

### 7. Pricing-Rationale

- **$4.99 Einmalkauf** statt Abo, weil:
  - BYOK = Nutzer zahlt bereits für API-Nutzung beim Provider
  - Kein laufender Server-Kostenpunkt für den Entwickler
  - Einmalkauf senkt die Kaufhürde drastisch vs. Abo
  - Chrome Web Store-Nutzer bevorzugen Einmalkäufe (höhere Conversion)

- **Free-Tier** ist bewusst nutzbar (nicht verkrüppelt):
  - 3 Provider decken die gängigsten kostenlosen/günstigen Modelle ab
  - 10 Tabs reichen für einfache Recherchen
  - Nutzer erlebt den vollen Workflow, will dann mehr
