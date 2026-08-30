# Design System Master File — WhatsApp Dashboard Bot

> **LOGIC:** When building a specific page, first check `design-system/whatsapp-dashboard-bot/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file. Otherwise follow the rules below.
>
> This file reflects the **final adopted decisions** (Stage 0), reconciling the
> `ui-ux-pro-max` skill's raw recommendations with constraints the raw tool output
> could not see: the app is **Arabic-first RTL** (`html { direction: rtl }`, Cairo
> font) and already ships a mature 3-layer token system in `frontend/src/index.css`.
> Where the skill's generic suggestion (light theme, Latin-only font, generic blue)
> conflicted with those constraints, the project's existing direction was kept and
> only *upgraded*, not replaced.

---

**Category:** RPA / Automation Dashboard (WhatsApp bot operations console)
**Design Dials:** Variance 6/10 (Balanced/Modern) · Motion 6/10 (Standard) · Density 8/10 (Dense/Dashboard)
**Base direction:** Dark-first, "Modern Dark Cinema" style (same family as Linear/Vercel) — matches project's existing dark base + adds a dedicated interactive accent.

---

## Color Palette (adopted, in `frontend/src/index.css`)

Two-track brand system — intentional, do not collapse into one:

| Role | Token | Value (dark) | Purpose |
|---|---|---|---|
| Brand primary | `--brand-primary-600` | `#00a884` | WhatsApp-adjacent identity: connection status, primary CTAs, success/live states |
| Interactive accent | `--accent` (indigo-500) | `#5e6ad2` | Links, active nav item, focus rings on non-form surfaces, AI Assistant panel, chart series 2 |
| Success | `--success` | `#22c55e` | Positive status (kept distinct from brand green in dense tables) |
| Warning | `--warning` | `#f59e0b` | Pending / degraded |
| Danger | `--danger` | `#ef4444` | Errors, disconnected, destructive actions |
| Info | `--info` | `#3b82f6` | Neutral informational badges |
| Background (dark) | `--bg-app` | `#080c14` (neutral-950) | App shell |
| Surface | `--bg-surface` | `#0e1521` | Cards, panels |

Full 50–950 ramps exist for `brand-primary`, `brand-secondary`, `accent-indigo`, and `neutral`. Light theme mirrors all semantic tokens via `[data-theme="light"]`.

**Rule:** never introduce a third arbitrary accent hue. Green = brand/status, Indigo = interactive/navigational, Amber/Red/Blue = semantic status only.

## Typography (adopted)

- **Body/UI font:** Cairo (existing) — kept because it's the only stack font with full Arabic glyph coverage; Inter (skill's raw suggestion) does not support Arabic and was rejected for that reason.
- **Mono/data font:** IBM Plex Mono (existing) — matches the skill's "Dashboard Data" mono pairing intent (precise, technical, good digit legibility) and already covers Arabic-adjacent Latin numerals cleanly.
- Scale: Display 2XL→Caption, already defined as `--fs-*` tokens with responsive step-down at 768px. No changes needed — it already matches the skill's "Dashboard Data" fixed technical scale.

## Spacing — 8pt grid, Dense preset (adopted, already implemented)

`--space-1` (4px) through `--space-64` (256px), already present. Matches Density 8/10 recommendation directly (8–32px dominant range for dashboard density, larger tokens reserved for page-level rhythm).

## Radius / Shadow / Elevation (adopted, already implemented)

`--radius-xs` → `--radius-full`, `--shadow-xs` → `--shadow-2xl` plus `--shadow-glass`, `--shadow-floating`, `--shadow-glow`. Elevation utility classes `.elevation-0` → `.elevation-6` map directly onto the shadow scale — this already satisfies the Level 0–6 elevation system requirement.

## Motion (adopted + extended this stage)

Existing library covers fade/slide/scale/zoom/bounce/shimmer/ripple with a proper easing set (`--ease-standard`, `--ease-spring`, `--ease-bounce`) and `prefers-reduced-motion` handling.

**Added in Stage 0** (previously missing, now present in `index.css`):
- `.animate-grid-item` — staggered grid-entry animation (skill's "Stagger List" preset, translated from GSAP to pure CSS keyframes since the project has no GSAP dependency: `back.out`-equivalent via `--ease-bounce`)
- `.animate-modal-in` — spring-in for dialogs/drawers (skill's Cinema-style spring modal, damping-like overshoot via `--ease-spring`)
- `.stagger-children` delay ladder was already present (nth-child 1–8, 50ms steps) — reused as-is for grid staggering.

## Components added this stage (previously absent)

- **`.chip` family** (`.chip-brand`, `.chip-accent`, `.chip-success`, `.chip-warning`, `.chip-danger`, `.chip-interactive`, `.chip-removable`) — the component list required Chips/Tags but no CSS backing existed. A dedicated `<Chip>` React component still needs to be built in Stage 1 to consume these classes (not yet created — CSS primitives only).
- **`.status-dot` family** (`live` / `pending` / `error` / `idle`, plus `.status-dot-pulse`) — needed across Groups/Accounts/Diagnostics views for connection-state indicators; did not exist as a reusable primitive before.

## Anti-patterns (enforced, from skill checklist)

- ❌ No emoji icons — Lucide only (already the project's icon library)
- ❌ No light-mode-only assumptions — dark is default (`:root, [data-theme="dark"]`)
- ✅ `cursor-pointer` on all interactive elements (enforce in Stage 1 component pass)
- ✅ Focus-visible outline present globally (`:focus-visible` rule already exists)
- ✅ `prefers-reduced-motion` handled globally
- ✅ `prefers-contrast: high` handled globally

## Pre-delivery checklist status (Stage 0)

- [x] Token architecture (primitive → semantic → component) — pre-existing, verified sound
- [x] Dark + light theme parity — pre-existing, verified sound
- [x] RTL support — pre-existing, must be preserved in every future stage
- [x] Reduced motion / high contrast — pre-existing
- [x] Interactive accent distinct from brand color — **added this stage**
- [x] Chip/Tag primitives — **added this stage**
- [x] Status-dot primitives — **added this stage**
- [x] Additional motion presets (grid stagger, modal spring) — **added this stage**
- [x] Build verified (`npm run build` succeeds, CSS output 107.8kB / 18.16kB gzip)
- [ ] Component-level a11y audit (cursor-pointer, aria-labels, contrast per component) — deferred to Stage 1
- [ ] Chip/StatusDot React components — deferred to Stage 1
