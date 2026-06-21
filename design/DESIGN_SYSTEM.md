# Design System — Omni-Context V2 (Linear/Raycast)

## Color Palette

### Backgrounds (luminance stacking)
| Token | Value | Role |
|-------|-------|------|
| `--oc-bg` | `#08090a` | Page background — near-black with cool undertone |
| `--oc-surface` | `rgba(255,255,255,0.03)` | Elevated areas (cards, inputs) |
| `--oc-surface-hover` | `rgba(255,255,255,0.05)` | Hover state for surfaces |
| `--oc-surface-active` | `rgba(255,255,255,0.08)` | Active/pressed state |

### Text
| Token | Value | Role |
|-------|-------|------|
| `--oc-text` | `#f7f8f8` | Primary text — near-white, not pure white |
| `--oc-text-secondary` | `#d0d6e0` | Body text, descriptions |
| `--oc-text-dim` | `#8a8f98` | Metadata, placeholders, muted |
| `--oc-text-muted` | `#62666d` | Disabled, least important |

### Accent (Indigo)
| Token | Value | Role |
|-------|-------|------|
| `--oc-accent` | `#5e6ad2` | Primary accent — CTA backgrounds, active states |
| `--oc-accent-hover` | `#828fff` | Accent hover — lighter variant |
| `--oc-accent-dim` | `rgba(94,106,210,0.12)` | User message background tint |
| `--oc-accent-border` | `rgba(94,106,210,0.2)` | User message border |
| `--oc-accent-text` | `#828fff` | Accent-colored text (scores, badges) |

### Borders
| Token | Value | Role |
|-------|-------|------|
| `--oc-border` | `rgba(255,255,255,0.06)` | Default border — barely visible |
| `--oc-border-strong` | `rgba(255,255,255,0.1)` | Emphasized borders (inputs focus) |

### Semantic
| Token | Value | Role |
|-------|-------|------|
| `--oc-success` | `#27a644` | Status ready, connected |
| `--oc-danger` | `#ef4444` | Errors, disconnect |
| `--oc-warning` | `#f59e0b` | Warnings |

## Typography

- **Font stack:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
- **Mono:** `'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace`
- **Base size:** 13px (Chrome sidepanel optimal)
- **Weights:** 400 (body), 500 (emphasis/navigation), 600 (headings/strong)
- **Letter-spacing:** -0.2px on 13px+ headings, normal on body

## Border Radius

| Token | Value | Use |
|-------|-------|-----|
| `--oc-radius-xs` | `4px` | Small chips, inline badges |
| `--oc-radius-sm` | `6px` | Buttons, inputs, nav pills |
| `--oc-radius` | `8px` | Cards, containers |
| `--oc-radius-lg` | `12px` | Large panels, modals |
| `--oc-radius-pill` | `9999px` | Source chips, filter pills |

## Spacing

8px base grid: 4, 6, 8, 12, 16, 20, 24, 32

## Component Principles

### Buttons
- **Primary:** `background: var(--oc-accent)`, white text, 6px radius
- **Secondary/Ghost:** `background: rgba(255,255,255,0.03)`, `border: 1px solid var(--oc-border)`, dim text
- **Icon buttons:** No background, dim text, hover → surface + text brightens

### Cards (Provider cards, etc.)
- `background: var(--oc-surface)`
- `border: 1px solid var(--oc-border)`
- `border-radius: var(--oc-radius)`
- Active: `border-color: rgba(94,106,210,0.4)`, `background: rgba(94,106,210,0.08)`
- Locked/disabled: `opacity: 0.35`

### Chat Messages
- **User:** Accent-tinted bg + border, rounded 12px top, 4px bottom-right
- **AI:** No background/border — just text flowing naturally
- **Sources:** Pill chips with `9999px` radius, `rgba(255,255,255,0.04)` bg

### Input Area
- Wrapped container with surface bg + border
- Input borderless inside container
- Send button: small square, accent bg, arrow icon

### Navigation
- Pill-style tabs with `6px` radius
- Active: `rgba(255,255,255,0.05)` bg, bright text
- Inactive: no bg, muted text

## Key Differences from Current Design
1. No gradients anywhere
2. No glow/neon effects
3. Borders are semi-transparent white, not solid colors
4. Surfaces use alpha transparency, not solid hex
5. Single accent color (indigo) instead of blue + blue-dim + blue-glow
6. Text hierarchy via opacity/weight, not color shifts to blue
7. No emojis in UI chrome
