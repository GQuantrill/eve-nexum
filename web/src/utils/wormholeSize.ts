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

// ── Size ceiling implied by the systems a hole connects ───────────────────────
//
// A wormhole touching a C1 is never bigger than medium: nothing in the chart
// that spawns in or leads to a C1 exceeds "up to Battlecruiser" (the test next
// to this asserts that against the chart itself, so it fails if CCP changes it).
//
// This matters for a K162, which carries no size of its own -- the forward side
// is in the other system and we have not seen it. A K162 therefore sits at the
// 'large' column default, which for a C1 hole is wrong and optimistic: it says a
// battleship fits when nothing above a battlecruiser can pass.
//
// Deliberately a CEILING, not an assignment. Holes into a C1 are mostly medium
// but E004 is a destroyer-sized frigate hole, so "touches a C1" does not pin the
// size exactly -- it only rules out anything larger. Lowering a too-large value
// is safe; raising a smaller one would claim a capacity we cannot support.
const SIZE_ORDER: Record<WhSizeClass, number> = { small: 0, medium: 1, large: 2, xl: 3 };

/** The smaller of two size classes. */
export function smallerSize(a: WhSizeClass, b: WhSizeClass): WhSizeClass {
  return SIZE_ORDER[a] <= SIZE_ORDER[b] ? a : b;
}

/** True when `size` is bigger than `cap` — i.e. the cap would lower it. */
export function exceedsSize(size: string | null | undefined, cap: WhSizeClass): boolean {
  const s = (size ?? '') as WhSizeClass;
  return s in SIZE_ORDER && SIZE_ORDER[s] > SIZE_ORDER[cap];
}

/**
 * The largest size a hole between systems of these classes can be, or null when
 * the endpoints imply no ceiling. Either end being a C1 is the only case today.
 */
export function sizeCapForClasses(
  a: string | null | undefined, b: string | null | undefined,
): WhSizeClass | null {
  return a === 'C1' || b === 'C1' ? 'medium' : null;
}

/**
 * The size a connection should hold, or null to leave it alone.
 *
 * The whole size-inference decision in one place: the panel effect only calls
 * this, so the rules are testable without a DOM and cannot drift between the
 * typed path and the K162 path.
 *
 *   known code   authoritative, held under any endpoint ceiling.
 *   no code      (K162, or types not loaded) the ceiling only LOWERS what is
 *                already set -- touching a C1 rules out bigger holes without
 *                pinning the size, since E004 into a C1 is destroyer-sized. A
 *                scout who set small keeps small.
 */
export function inferredSize(args: {
  code:        string | null | undefined;
  whTypes:     Record<string, { maxJumpMass?: number } | undefined>;
  currentSize: string | null | undefined;
  classA:      string | null | undefined;
  classB:      string | null | undefined;
}): WhSizeClass | null {
  const cap = sizeCapForClasses(args.classA, args.classB);
  const fromType = whSizeForType(args.code, args.whTypes);
  if (fromType) return cap ? smallerSize(fromType, cap) : fromType;
  if (cap && exceedsSize(args.currentSize, cap)) return cap;
  return null;
}
