import type { BuiltinIntel, CustomIntel, SystemIntel } from '../types';

/** Canonical colour for each built-in intel value. Used as the base for
 *  the background tint and the swatch in the right-click submenu. */
const BUILTIN_COLORS: Record<BuiltinIntel, string> = {
  friendly: '#5b9bff',
  hostile:  '#e05a5a',
  occupied: '#f0a030',
  empty:    '#8c98ac',
};

const BUILTIN_KEYS = new Set<string>(['friendly', 'hostile', 'occupied', 'empty']);

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
 *  sidebar swatches). Returns the raw id when nothing matches so debugging
 *  isn't blind. */
export function resolveIntelLabel(intel: SystemIntel | null | undefined, customs: CustomIntel[]): string | null {
  if (!intel) return null;
  if (isBuiltinIntel(intel)) {
    return intel.charAt(0).toUpperCase() + intel.slice(1);
  }
  const match = customs.find((c) => c.id === intel);
  return match ? match.label : intel;
}

