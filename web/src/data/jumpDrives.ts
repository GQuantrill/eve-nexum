// EVE jump-drive ranges by ship class. `base` is the JDC-0 maximum range in light
// years; Jump Drive Calibration adds +20% per level, so effective max range =
// base * (1 + 0.2 * jdc). At JDC V (the norm) this gives: Jump Freighter/Rorqual
// 10 ly, Black Ops 8, Carrier/Dread/FAX 7, Super/Titan 6. Ordered longest-first so
// the "reachable by" list reads widest-class-first.
export interface JumpClass {
  key:      string;
  label:    string;
  base:     number;   // max range (ly) at JDC 0
  color:    string;
  fuelPerLy: number;  // base isotopes/ly at JFC 0 (estimateFuel applies the JFC cut)
}

// Colours are from the Wong colour-blind-safe palette (sky-blue / yellow /
// reddish-purple / bluish-green / orange) so the range tiers stay distinguishable
// across vision types without needing per-palette CSS vars.
export const JUMP_CLASSES: JumpClass[] = [
  // fuelPerLy measured in-game at JFC 0 (single ~7.4 ly jumps): JF 4700,
  // Rorqual 4000, Blops 700, Carrier/Dread/FAX 3000, Super/Titan 3000. JF and
  // Rorqual share max range (10 ly) but differ in fuel, and only the JF gets the
  // Jump Freighters skill cut, so they are separate classes.
  { key: 'jf',      label: 'Jump Freighter',           base: 5.0, color: '#56b4e9', fuelPerLy: 4700 },
  { key: 'rorqual', label: 'Rorqual',                  base: 5.0, color: '#f0e442', fuelPerLy: 4000 },
  { key: 'blops',   label: 'Black Ops',                base: 4.0, color: '#cc79a7', fuelPerLy: 700 },
  { key: 'carrier', label: 'Carrier / Dread / FAX',    base: 3.5, color: '#009e73', fuelPerLy: 3000 },
  { key: 'super',   label: 'Super / Titan',            base: 3.0, color: '#e69f00', fuelPerLy: 3000 },
];

/** Effective max jump range (ly) for a base range at a given JDC skill level. */
export const jumpRange = (base: number, jdc: number): number => base * (1 + 0.2 * jdc);

/**
 * Isotopes for a route of `totalLy` light-years, from the measured JFC-0 base
 * per class. Jump Fuel Conservation cuts consumption 10%/level; the Jump
 * Freighters skill cuts it a further 10%/level for jump freighters only. Close
 * to in-game, but per-class (individual hulls vary slightly) and fuel-type-blind.
 */
export function estimateFuel(totalLy: number, classKey: string, jfc: number, jumpFreighters: number): number {
  const c = JUMP_CLASSES.find((x) => x.key === classKey);
  if (!c) return 0;
  let factor = Math.max(0, 1 - 0.1 * jfc);
  if (classKey === 'jf') factor *= Math.max(0, 1 - 0.1 * jumpFreighters);
  return Math.round(totalLy * c.fuelPerLy * factor);
}

// ── Jump fatigue ─────────────────────────────────────────────────────────────
// EVE jump-fatigue model (per the narcolepsy calculator). Jump drives get no
// fatigue bonus, so bonus = 0 for everything the planner routes. Per jump of d
// light-years, starting from the previous fatigue:
//   fatigue  = min(300, max(prevFatigue, 10) * (1 + d))   // minutes, caps at 5h
//   cooldown = max(fatigue / 10, 1 + d)                    // from the NEW fatigue
// We assume a fresh start (0 fatigue) and back-to-back jumps (decay ignored), so
// this is the worst-case run. Fatigue caps at 300 min (5 hours).
export interface FatigueResult {
  /** Reactivation cooldown (min) for the jump into each hop; null for the origin. */
  perHop: (number | null)[];
  peakFatigueMin: number;
  totalCooldownMin: number;   // sum of cooldowns = the run's wall-clock jump time
  hitCap: boolean;            // true if fatigue ever pinned the 5h cap
}

export function computeFatigue(hops: { lyFromPrev: number }[]): FatigueResult {
  let fatigue = 0, total = 0, peak = 0;
  let hitCap = false;
  const perHop: (number | null)[] = [];
  hops.forEach((h, i) => {
    if (i === 0) { perHop.push(null); return; }   // origin — no jump
    const d = h.lyFromPrev;
    fatigue = Math.min(300, Math.max(fatigue, 10) * (1 + d));
    const cooldown = Math.max(fatigue / 10, 1 + d);
    if (fatigue >= 300) hitCap = true;
    peak = Math.max(peak, fatigue);
    total += cooldown;
    perHop.push(cooldown);
  });
  return { perHop, peakFatigueMin: peak, totalCooldownMin: total, hitCap };
}

/** Minutes → compact "5h" / "1h 30m" / "45m". */
export function formatMinutes(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** Classes (longest-range first) that can make a jump of `ly` light years at `jdc`. */
export function classesInRange(ly: number, jdc: number): JumpClass[] {
  return JUMP_CLASSES.filter((c) => ly <= jumpRange(c.base, jdc));
}

/** The widest range any class can make at this JDC — how far the overlay fetches. */
export const maxRangeLy = (jdc: number): number =>
  Math.max(...JUMP_CLASSES.map((c) => jumpRange(c.base, jdc)));
