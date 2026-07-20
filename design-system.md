# Nexum design-system / CSS refactor plan

Long-lived work on the `design` branch (not qa). Goal: get off the ~9.7k-line
monolithic `App.css` with ~1,570 hardcoded hex colours, onto **design tokens +
co-located CSS Modules**, so (a) the code is maintainable and (b) a runtime
colour-theming tool becomes possible.

Chosen approach (decided 2026-07-21):
- **Styling:** CSS Modules (`Component.module.css`, co-located) for component
  styles. No new build deps — Vite supports both natively.
- **Tokens:** design tokens as **CSS custom properties** in a small global
  `web/src/styles/tokens.css`. Runtime-swappable → exactly what the theming tool
  needs (same mechanism the existing `--cv-*` colour-vision modes already use).
- **Order:** tokens first (unblock theming), component split second.

Guiding rule: **every step is visual-output-preserving.** Tokens are defined to
today's exact values; the hex→token sweep changes nothing on screen. No sizes or
colours change without an explicit design decision.

## Where things live (target)

```
web/src/styles/
  tokens.css      # design tokens (colour + non-colour), theme variants, colour-vision
  reset.css       # (existing index.css → normalise here) minimal reset/base
  global.css      # base typography, a few shared utilities — kept deliberately small
  layout.css      # shared layout primitives (.layout, panels, split rows) if warranted
web/src/components/<Area>/Component.module.css   # co-located, scoped
```
`App.css` shrinks toward zero as sections move out.

## Token layers (in tokens.css)

1. **Primitive palette** (raw values) — optional; can inline for now.
2. **Semantic UI-chrome tokens** — `--surface-*`, `--border-*`, `--text-*`,
   `--accent-*`, `--danger/--success/--warning`. THIS is the new layer the audit
   showed is missing; the chrome hex (`#1e2740` ×117, `#0d1117` ×41, …) collapses
   into ~20-30 of these.
3. **Existing semantic map colours** — the `--cv-*` set (security/class/intel/
   standings/connection/status/storm/effect/watch/sig) + the 3 colour-vision
   variant blocks. Moved verbatim from App.css.
4. **Non-colour tokens** — `--font-scale` (exists), radii, spacing (add as we go).

Theme variants (light/dark, custom themes) become sibling `:root[data-theme="…"]`
blocks that re-map the semantic tokens — the contributor's theming tool writes
these.

## Phases

- **Phase 1 — token foundation (this PR):** create `tokens.css`; move the `--cv-*`
  + colour-vision blocks out of App.css; define the semantic chrome tokens at
  today's values; sweep the high-frequency chrome hex in App.css → `var(--token)`.
  No visual change. Unblocks theming for the chrome (the map colours are already
  tokenised).
- **Phase 1b — long-tail colours:** tokenise the remaining one-off hex / `rgba()`
  as they surface (mostly handled during the component split).
- **Phase 2 — component split:** carve App.css into `Component.module.css` by the
  ~58 existing section headers, one area per PR. Convert that area's hardcoded
  values to tokens as it moves; update the component to `styles.foo`. Global
  bits (reset, base typography, small utilities) land in `global.css`; shared
  layout in `layout.css`.
- **Phase 3 — theming:** add light/dark (+ custom) theme token blocks and the
  contributor's theming UI, which just writes token values onto `:root`.

## Conventions

- Component classes are scoped by the module; keep names local (`.row`, `.header`)
  — no more BEM-y global `.watchlist__row-top`.
- Reference tokens, never raw hex, in component CSS (lint/review gate later).
- Don't consolidate near-duplicate colours during a value-preserving sweep — that
  changes pixels. Note them for a deliberate design pass.
