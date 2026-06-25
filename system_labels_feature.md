# System labels

Per-system labels shown as coloured pill badges ABOVE the node. Like Wanderer's
labels, but: many predefined at once, a custom label, and the custom label can
be **text OR an icon** (the "better" bit). Distinct from the single-char *tag*
(a separate concept, not this feature).

## Picker (right-click system -> Labels submenu)

```
Custom label   (opens a small dialog: text input + icon picker)
Clear          (removes all labels on the system)
---
Label A    (toggle, green)
Label B    (toggle, blue)
Label C    (toggle, amber)
Label 1    (toggle, violet)
Label 2    (toggle, teal)
Label 3    (toggle, pink)
```

- Predefined labels A/B/C/1/2/3 toggle on/off independently — multiple at once.
- A check mark shows which are currently applied.
- "Custom label" opens a dialog to set EITHER free text OR an icon (one custom
  per system in v1). Setting it again replaces it; Clear removes everything.

## Display — pills above the node

- A horizontal row of pill badges anchored just above the node's top-left,
  rendered inside the node component but absolutely positioned (negative top),
  so they sit outside the node body (matches the reference screenshot).
- Each predefined label = a coloured pill with its char (A/B/C/1/2/3).
- Custom text = a neutral dark pill, white text.
- Custom icon = a coloured pill containing a Phosphor icon.
- Order: predefined in fixed A,B,C,1,2,3 order, then the custom one.

### Default colours (CSS vars, easy to retune)
A green · B blue · C amber · 1 violet · 2 teal · 3 pink · custom dark/white.

## Data model

`map_systems` gains:
- `labels TEXT[] NOT NULL DEFAULT '{}'` — applied predefined ids, subset of
  `{a,b,c,1,2,3}`.
- `custom_labels TEXT[] NOT NULL DEFAULT '{}'` — up to **3** custom entries, each
  prefixed: `t:<text>` for a text label or `i:<IconName>` for a Phosphor icon.

`MapSystem` (web type) gains `labels: string[]`, `customLabels: string[]`
(raw prefixed strings; parsed to `{kind,value}` at render).

Decisions: (1) up to **3** custom labels per system; (2) **all** of Phosphor in
the icon picker for now (may curate later); (3) colours as above.

## Persistence (reuses the intel path)

- Set via `updateSystem(id, { labels })` / `{ customLabel }` / `{ customIcon }` —
  the same optimistic-store + `PATCH /maps/:mapId/systems/:id` + live-sync flow
  `intel` already uses (`mapStore.updateSystem`, `maps.ts` PATCH handler).
- Server PATCH handler whitelists the three columns; `mapRead` selects them.
- Live-sync: the existing system-update broadcast carries them to the corp.

## Icon picker

- Phosphor icons (already a dep). The custom-label dialog has a text field and a
  searchable icon grid; picking an icon clears the text and vice-versa.
- Stored as the icon's component name (e.g. `Skull`), resolved on the node.

## Files

- `server/scripts/setup-db.ts` + `server/src/migrate.ts` — 3 new columns.
- `server/src/routes/maps.ts` — PATCH whitelist; `mapRead.ts` — SELECT.
- `web/src/types/index.ts` — MapSystem fields.
- `web/src/store/mapStore.ts` — addSystem defaults (no change to updateSystem).
- `web/src/data/labels.ts` (new) — label ids, names, colours, order.
- `web/src/components/map/MapCanvas.tsx` — Labels submenu.
- `web/src/components/ui/CustomLabelDialog.tsx` (new) — text + icon picker.
- `web/src/components/map/SystemNode.tsx` + `App.css` — pill row above node.
- `web/src/i18n/locales/*/common.json` — Labels / Custom label / Clear / Label
  A–C / Label 1–3 in all 9 locales.

## Open questions (need your call)

1. **One custom label per system, or several?** (v1 above assumes one — matches
   Wanderer.)
2. **Icon set:** all of Phosphor (searchable), or a small curated set?
3. Colours above OK, or you have specific ones?
