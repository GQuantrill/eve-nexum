import * as Phosphor from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

// Resolve / list Phosphor icons by base name (e.g. 'Skull' → SkullIcon), for
// the custom-label icon picker and node rendering. "All of Phosphor for now" —
// this imports the whole set; revisit (curated list) if bundle size matters.

const SUFFIX = 'Icon';

// Phosphor icons are forwardRef components — i.e. OBJECTS, not functions — so a
// `typeof === 'function'` check rejects every one. Accept any non-null export.
const isComponent = (v: unknown): boolean =>
  v != null && (typeof v === 'object' || typeof v === 'function');

export function iconComponent(name: string): Icon | null {
  const c = (Phosphor as Record<string, unknown>)[`${name}${SUFFIX}`];
  return isComponent(c) ? (c as Icon) : null;
}

// Every icon's base name (no 'Icon' suffix), sorted. Excludes the bare `Icon`
// type export and any non-icon exports (IconContext, IconBase, SSR…).
export const ALL_ICON_NAMES: string[] = Object.keys(Phosphor)
  .filter((k) => k.endsWith(SUFFIX) && k !== SUFFIX && isComponent((Phosphor as Record<string, unknown>)[k]))
  .map((k) => k.slice(0, -SUFFIX.length))
  .filter((n) => n.length > 0)
  .sort();
