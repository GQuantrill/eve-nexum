import type { TFunction } from 'i18next';

// One source of truth for "what size is this wormhole". The size class is the
// largest ship that can pass, i.e. the SDE per-jump cap (wormholeMaxJumpMass,
// attr 1385) served by /api/wormholes/types. Thresholds match the SDE's actual
// value clusters: 5M -> S, 62M -> M, 375M/410M -> L, 1B/2B -> XL.
export type WhSizeClass = 'xl' | 'large' | 'medium' | 'small';

export function whSizeClass(maxJumpMass: number | null | undefined): WhSizeClass | null {
  if (!maxJumpMass || maxJumpMass <= 0) return null;
  if (maxJumpMass >= 1_000_000_000) return 'xl';
  if (maxJumpMass >= 300_000_000)   return 'large';
  if (maxJumpMass >= 62_000_000)    return 'medium';
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
