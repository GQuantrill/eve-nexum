import type { TFunction } from 'i18next';
import type { BuiltinIntel, CustomIntel, SystemIntel } from '../types';

/** Canonical colour for each built-in intel value. Used as the base for
 *  the background tint and the swatch in the right-click submenu. */
// CSS custom properties so the colour-vision palettes (--cv-intel-* in
// App.css) re-map built-in intel colours per mode. Custom user intel tags
// keep their own stored hex.
const BUILTIN_COLORS: Record<BuiltinIntel, string> = {
  friendly: 'var(--cv-intel-friendly)',
  hostile:  'var(--cv-intel-hostile)',
  occupied: 'var(--cv-intel-occupied)',
  empty:    'var(--cv-intel-empty)',
};

const BUILTIN_KEYS = new Set<string>(['friendly', 'hostile', 'occupied', 'empty']);

// Built-in intel labels reuse the right-click menu's translations so the
// sidebar badge and the context menu always read the same.
const BUILTIN_LABEL_KEYS: Record<BuiltinIntel, 'ctxMenu.intelFriendly' | 'ctxMenu.intelHostile' | 'ctxMenu.intelOccupied' | 'ctxMenu.intelEmpty'> = {
  friendly: 'ctxMenu.intelFriendly',
  hostile:  'ctxMenu.intelHostile',
  occupied: 'ctxMenu.intelOccupied',
  empty:    'ctxMenu.intelEmpty',
};

export function isBuiltinIntel(value: string): value is BuiltinIntel {
  return BUILTIN_KEYS.has(value);
}

/** Resolve an intel tag to its base hex colour. Returns null when the tag
 *  is unknown (e.g. a custom id whose definition the current user doesn't
 *  have because the tag was set by another character). Caller can fall back
 *  to a neutral grey or leave the background untouched. */
export function resolveIntelColor(intel: SystemIntel | null | undefined, customs: CustomIntel[]): string | null {
  if (!intel) return null;
  if (isBuiltinIntel(intel)) return BUILTIN_COLORS[intel];
  const match = customs.find((c) => c.id === intel);
  return match ? match.color : null;
}

/** Resolve an intel tag to its human-readable label. Mirrors
 *  [[resolveIntelColor]] for label lookups (right-click checkmarks,
 *  sidebar swatches). Built-in tags are translated via `t` when supplied
 *  (falls back to a capitalised id otherwise); custom labels are user data
 *  and pass through untouched. Returns the raw id when nothing matches so
 *  debugging isn't blind. */
export function resolveIntelLabel(intel: SystemIntel | null | undefined, customs: CustomIntel[], t?: TFunction): string | null {
  if (!intel) return null;
  if (isBuiltinIntel(intel)) {
    return t ? t(BUILTIN_LABEL_KEYS[intel]) : intel.charAt(0).toUpperCase() + intel.slice(1);
  }
  const match = customs.find((c) => c.id === intel);
  return match ? match.label : intel;
}

