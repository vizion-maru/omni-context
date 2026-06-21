# Design Review — Omni-Context Chrome Extension

## Current State Analysis

### Problems with Current UI
1. **Generic AI-coded look** — Standard blue (#3B82F6) + violet gradient = Claude/Tailwind default
2. **Neon glow effects** — `accent-glow: rgba(59, 130, 246, 0.15)` everywhere
3. **Logo gradient** — `linear-gradient(135deg, #3B82F6, #818cf8)` is the most stereotypical AI-app gradient
4. **Too many custom tracking values** — 0.06em, 0.07em, 0.08em look over-engineered but add no visual identity
5. **Surface hierarchy too blue** — `#0f1117`, `#1a1d27`, `#222536` all have blue undertones = looks like generic SaaS dashboard
6. **Emoji usage** — Welcome state uses 🔍, 💾, 🔑 — amateurish for a premium tool
7. **Spacing system is arbitrary** — 4, 6, 8, 10, 12, 16, 20, 22, 24, 36, 40 has no clear rhythm

### What Works
- Token-based architecture (CSS custom properties) — easy to swap
- Component structure is clean (header → nav → messages → input)
- No build system = no toolchain bloat, direct CSS editing

### Technical Constraints
- Chrome Extension Sidepanel (narrow width ~400px)
- No external font loading (must use system stack or bundle)
- No build system — vanilla CSS only
- Dark mode only
- Must not change any JS functionality

## Recommended Direction: V2 — Linear/Raycast Premium

**Why V2:**
- Highest quality-per-complexity ratio
- Near-black backgrounds (`#08090a`) feel native to Chrome dark mode
- Indigo-purple accent (`#5e6ad2`) is distinctive without being flashy
- Semi-transparent borders (`rgba(255,255,255,0.06-0.08)`) instead of solid colored borders
- Typography hierarchy through weight (400/500/600) not color
- Source chips as pills (9999px radius) vs rectangles = more refined
- Chat bubbles: user messages get subtle accent tint, AI messages are borderless text = natural conversation flow
