import type { TFunction } from 'i18next';

// One source of truth for "what size is this wormhole". The size class is the
// largest ship that can pass, i.e. the SDE per-jump cap (wormholeMaxJumpMass,
// attr 1385) served by /api/wormholes/types. Thresholds match the SDE's actual
// value clusters: 5M -> S, 62M -> M, 375M/410M -> L, 1B/2B -> XL.
export type WhSizeClass = 'xl' | 'large' | 'medium' | 'small';

// Per-jump mass thresholds (kg) — the single source of truth for wormhole size.
// Any classifier (the S/M/L/XL one below, the descriptive chart tiers) must read
// these so they can never drift. `capital` is the freighter-vs-capital split the
// descriptive chart draws; the 4-tier S/M/L/XL system folds it into `xl`.
export const WH_JUMP_MASS = {
  capital: 2_000_000_000,
  xl:      1_000_000_000,
  large:     300_000_000,
  medium:     62_000_000,
} as const;

export function whSizeClass(maxJumpMass: number | null | undefined): WhSizeClass | null {
  if (!maxJumpMass || maxJumpMass <= 0) return null;
  if (maxJumpMass >= WH_JUMP_MASS.xl)     return 'xl';
  if (maxJumpMass >= WH_JUMP_MASS.large)  return 'large';
  if (maxJumpMass >= WH_JUMP_MASS.medium) return 'medium';
  return 'small';
}

// Size class for a wormhole code, given the loaded /api/wormholes/types map.
export function whSizeForType(
  code: string | null | undefined,
  whTypes: Record<string, { maxJumpMass?: number } | undefined>,
): WhSizeClass | null {
  if (!code) return null;
  return whSizeClass(whTypes[code.toUpperCase()]?.maxJumpMass);
}

// Verbose label (reuses the connection-panel size strings, e.g. "Large (Battleship)").
// Literal keys (not a lookup table) so the typed `t` accepts them.
export function whSizeLabel(t: TFunction, cls: WhSizeClass): string {
  switch (cls) {
    case 'xl':     return t('connPanel.sizeXl');
    case 'large':  return t('connPanel.sizeLarge');
    case 'medium': return t('connPanel.sizeMedium');
    case 'small':  return t('connPanel.sizeSmall');
  }
}

// Compact label for tight rows: XL / L / M / S.
const SHORT: Record<WhSizeClass, string> = { xl: 'XL', large: 'L', medium: 'M', small: 'S' };
export function whSizeShort(cls: WhSizeClass): string { return SHORT[cls]; }
