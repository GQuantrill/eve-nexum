// Interface density: how tightly the panel chrome is packed.
//
// Separate from --font-scale, which sizes the text. Text scaling alone left the
// padding at full size, so turning the font down just produced small text
// floating in unchanged chrome. Density moves the box metrics instead, and the
// two compose: a reader can have large text in tight chrome, or the reverse.

export const DENSITIES = ['comfortable', 'compact', 'dense'] as const;
export type Density = typeof DENSITIES[number];

export const DEFAULT_DENSITY: Density = 'comfortable';

/** A stored value, or the default when it is absent or not one we know. */
export function normaliseDensity(v: unknown): Density {
  return DENSITIES.includes(v as Density) ? (v as Density) : DEFAULT_DENSITY;
}

/**
 * Stamp the density on the document root, where the token overrides are keyed.
 *
 * The default is expressed as the ABSENCE of the attribute rather than
 * data-density="comfortable", so the default path resolves against the plain
 * :root block -- the same CSS that served before this feature existed.
 */
export function applyDensity(d: Density, root: HTMLElement = document.documentElement): void {
  if (d === DEFAULT_DENSITY) root.removeAttribute('data-density');
  else root.setAttribute('data-density', d);
}
