# Design Variants — Omni-Context

## V1: Chrome-Native Minimal
- **Palette:** Neutral dark grays (`#1b1b1f`, `#232328`), muted purple accent (`#a78bfa`)
- **Feel:** Understated, functional, blends with Chrome DevTools
- **Typography:** System stack, weight 500 emphasis
- **Borders:** Standard `rgba(255,255,255,0.08)`
- **Rating:** 5/10 — Too bland, no product identity

## V2: Linear/Raycast Premium ⭐ SELECTED
- **Palette:** Near-black (`#08090a`), indigo accent (`#5e6ad2` / `#828fff`)
- **Feel:** Precision-engineered, quiet confidence, zero visual noise
- **Typography:** System stack, Inter-inspired spacing, weight 500 baseline
- **Borders:** Ultra-subtle semi-transparent white (`rgba(255,255,255,0.06)`)
- **Surfaces:** Never solid — always `rgba(255,255,255, 0.03–0.08)` transparency
- **Key patterns:** Luminance stacking for depth, pills for metadata, borderless AI messages
- **Rating:** 8/10 — Most premium, least AI-generated look

## V3: Arc/Notion Workspace
- **Palette:** Warm dark (`#141414`), amber/orange accent (`#e8a56e`)
- **Feel:** Cozy workspace, Notion-inspired hierarchy
- **Typography:** Slightly larger (14px base), warmer spacing
- **Borders:** Warm-neutral `rgba(255,255,255,0.07)`
- **Rating:** 7/10 — Distinctive but "startup landing page" risk

## Selection Rationale

**V2 chosen because:**
1. Indigo accent is unique without being attention-seeking
2. Near-black bg (`#08090a`) feels chrome-native in dark mode
3. Semi-transparent surfaces create real depth without heavy shadows
4. No gradients, no glow = anti-AI-generated aesthetic
5. Pill-shaped source chips + borderless AI text = modern conversational UI
6. Scales well to both narrow sidepanel and wider options page
7. Matches the "productivity tool" positioning (Linear = project mgmt, Raycast = launcher)

## Files
- `DESIGN_VARIANTS.html` — Interactive comparison of all 3 variants
- `DESIGN_SYSTEM.md` — Token definitions and component specs for V2
- `DESIGN_REVIEW.md` — Current state analysis and problems identified
