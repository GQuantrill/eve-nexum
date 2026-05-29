# Internationalisation (i18n)

Scaffolding for translating Nexum's UI. Built on
[`react-i18next`](https://react.i18next.com/). This is the foundation only — most
UI strings are still hardcoded and get migrated to `t()` incrementally.

## What gets translated

**App chrome only** — buttons, labels, tooltips, hints, messages.

**NOT translated:** EVE game data — system names, ship/type names, and wormhole
codes/classes (`C1`–`C6`, `HS`, `LS`, `NS`, `K162`, `Thera`, …). These are
canonical English from the SDE/ESI and stay as-is everywhere.

## Layout

```
i18n/
  index.ts              init (detector + localStorage persistence, fallback en)
  i18next.d.ts          type-safe t() keys, checked against the en resource
  locales/<lng>/common.json   one JSON per language
```

`en` is the source of truth; every other locale mirrors its key shape.

## Using it in a component

```tsx
import { useTranslation } from 'react-i18next';

function Save() {
  const { t } = useTranslation();
  return <button>{t('actions.save')}</button>;
}
```

Keys are type-checked — a typo or missing key is a compile error.

### Interpolation & plurals

```tsx
t('units.jumps', { count: n })   // "1 jump" / "3 jumps"
```

Define plural forms with the `_one` / `_other` suffixes (see `units.jumps` in
`common.json`); i18next picks the right one per language's plural rules.

## Adding a string

1. Add the key to `locales/en/common.json` (and the same key to every other
   locale).
2. Replace the hardcoded text with `t('your.key')`.

## Adding a language

1. Create `locales/<code>/common.json` mirroring `en`.
2. Add `<code>` to `SUPPORTED_LANGUAGES` and `resources` in `index.ts`.
3. Add its native name to `LANGUAGE_NAMES` in
   `../components/ui/LanguageSwitcher.tsx`.

## Migration plan

1. ~~Foundation: library, init, language switcher~~ ✅ (this scaffolding)
2. Consolidate the scattered relative-time / mass / pluralisation formatters into
   i18n-aware helpers (the trickiest part — do before mass extraction).
3. Extract strings component-by-component into `common.json` (split into feature
   namespaces as it grows).
4. Add a real second language end-to-end to flush out text-overflow / format bugs.
