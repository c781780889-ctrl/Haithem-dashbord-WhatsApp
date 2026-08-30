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
## Stage 1 — Core UI Components (completed)

Audited all 30 existing `frontend/src/components/ui/*.tsx` files against the skill's a11y/RTL checklist. Overall quality was already high (proper ARIA roles, focus rings, cva variants) — Stage 1 fixed the real defects found rather than rewriting sound code:

**Bugs fixed:**
- `dialog.tsx` — replaced `left-[50%]`/`translate-x-[-50%]`/`slide-in-from-left` (physical-direction classes that visibly misposition and animate from the wrong edge under `html[dir="rtl"]`) with logical `inset-0 m-auto` centering + the new `.animate-modal-in` spring preset from Stage 0. `DialogHeader`/`DialogFooter` switched from `text-left`/`space-x-2` to logical `text-start`/`gap-2`.
- `table.tsx` — was using raw Tailwind defaults (`text-left`, `pr-0`, `bg-muted/50`) instead of the project's design tokens and logical properties. Rewritten to use `text-start`, `pe-0`, and `var(--bg-elevated)` etc., consistent with every other component.
- `select.tsx` / `dropdown-menu.tsx` — `SelectItem`, `DropdownMenuItem`, `DropdownMenuCheckboxItem` had hardcoded `pr-8`/`pl-2`/`right-2` for the check-indicator; switched to logical `pe-8`/`ps-2`/`end-2` so the indicator sits on the correct side in RTL.
- `ToastProvider.tsx` — icons/backgrounds used raw Tailwind palette colors (`text-green-500`, `bg-red-500/10`) that don't respond to the light/dark theme tokens; switched to `var(--success)`, `var(--danger)`, etc. Toast container centering switched from `left-1/2 -translate-x-1/2` to logical `inset-x-0 mx-auto`.

**New components added (previously absent from the 30-file set):**
- `chip.tsx` — `Chip` / `ChipGroup`, consuming the `.chip*` CSS primitives added in Stage 0. Includes overflow collapse (`+N`) for tag-heavy rows.
- `status-dot.tsx` — `StatusDot` / `StatusLabel`, consuming the `.status-dot*` CSS primitives added in Stage 0.
- `pagination.tsx` — `Pagination`, RTL-aware (previous/next arrows point the correct reading direction), with ellipsis collapsing for large page counts and an optional "showing X–Y of Z" range label.
- `file-upload.tsx` — `FileUpload` (drag-and-drop zone with size validation) / `FilePreviewItem`, needed for ad-creative uploads and account/session import flows.

**Deliberately left unchanged:** `button.tsx`, `card.tsx`, `badge.tsx`, `checkbox.tsx`, `switch.tsx`, `radio-group.tsx`, `tabs.tsx`, `accordion.tsx`, `tooltip.tsx`, `progress.tsx`, `skeleton.tsx`, `breadcrumb.tsx`, `alert.tsx`, `avatar.tsx`, `command-palette.tsx`, `empty-state.tsx`, `stat-card.tsx` — reviewed and found already correct (proper RTL-aware icon rotation, logical properties, token usage, ARIA). Rewriting working, correct code would have been busywork, not improvement.

**Known pre-existing issues found but out of scope for Stage 1** (they live in view files, not UI components — will be addressed when each view is rebuilt in Stage 3):
- `KeywordMonitoringView.tsx` calls `toast.info(...)`, `toast.success(...)`, `toast.error(...)` but `ToastProvider`'s `useToast()` only exposes `addToast`/`removeToast` — these calls are currently broken at the type level.
- `SubscriberMonitoringView.tsx` has the same `toast.error(...)` issue.
- `AccountsView.tsx` passes a toast callback with an incompatible signature.
- `ConnectionMethodModal.tsx` has three `if` comparisons against a `"connected"` status value that doesn't exist in its state union (dead code / likely bug).
- `GroupsView.tsx` passes a `dir` prop to `DropdownMenuContent` that Radix doesn't accept.

Build verified after Stage 1 (`npm run build` succeeds, CSS 118.68kB/19.37kB gzip, no new TypeScript errors introduced — confirmed by diffing `tsc --noEmit` output against files Stage 1 did not touch).

- [x] Component-level a11y/RTL audit — **done, Stage 1**
- [x] Chip/StatusDot/Pagination/FileUpload React components — **done, Stage 1**
- [ ] Pre-existing toast-API and dead-code issues in views — flagged for Stage 3 (page rebuilds)
