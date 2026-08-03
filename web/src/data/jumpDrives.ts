// EVE jump-drive ranges by ship class. `base` is the JDC-0 maximum range in light
// years; Jump Drive Calibration adds +20% per level, so effective max range =
// base * (1 + 0.2 * jdc). At JDC V (the norm) this gives: Jump Freighter/Rorqual
// 10 ly, Black Ops 8, Carrier/Dread/FAX 7, Super/Titan 6. Ordered longest-first so
// the "reachable by" list reads widest-class-first.
export interface JumpClass {
  key:   string;
  label: string;
  base:  number;   // ly at JDC 0
  color: string;
}

// Colours are the Wong colour-blind-safe quartet (sky-blue / reddish-purple /
// bluish-green / orange) so the range tiers stay distinguishable across vision
// types without needing per-palette CSS vars.
export const JUMP_CLASSES: JumpClass[] = [
  { key: 'jf',      label: 'Jump Freighter / Rorqual', base: 5.0, color: '#56b4e9' },
  { key: 'blops',   label: 'Black Ops',                base: 4.0, color: '#cc79a7' },
  { key: 'carrier', label: 'Carrier / Dread / FAX',    base: 3.5, color: '#009e73' },
  { key: 'super',   label: 'Super / Titan',            base: 3.0, color: '#e69f00' },
];

/** Effective max jump range (ly) for a base range at a given JDC skill level. */
export const jumpRange = (base: number, jdc: number): number => base * (1 + 0.2 * jdc);

/** Classes (longest-range first) that can make a jump of `ly` light years at `jdc`. */
export function classesInRange(ly: number, jdc: number): JumpClass[] {
  return JUMP_CLASSES.filter((c) => ly <= jumpRange(c.base, jdc));
}

/** The widest range any class can make at this JDC — how far the overlay fetches. */
export const maxRangeLy = (jdc: number): number =>
  Math.max(...JUMP_CLASSES.map((c) => jumpRange(c.base, jdc)));
