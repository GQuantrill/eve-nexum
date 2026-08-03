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

export const JUMP_CLASSES: JumpClass[] = [
  { key: 'jf',      label: 'Jump Freighter / Rorqual', base: 5.0, color: '#4ea1ff' },
  { key: 'blops',   label: 'Black Ops',                base: 4.0, color: '#b57bff' },
  { key: 'carrier', label: 'Carrier / Dread / FAX',    base: 3.5, color: '#4ecb8d' },
  { key: 'super',   label: 'Super / Titan',            base: 3.0, color: '#ff9d4e' },
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
