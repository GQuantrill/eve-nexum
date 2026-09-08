// Returns a CSS custom property so the colour-vision palettes (the --cv-sec-*
// vars in styles/tokens.css) can re-map the security gradient per mode.
//
// The band comes from the security as DISPLAYED, not as stored. Every caller
// renders `sec.toFixed(1)`, so banding on the raw value let two systems showing
// the same number take different colours: Mara at 0.4200 and Ishkad at 0.3660
// both display "0.4", but the raw values fall either side of the 0.4 boundary,
// so one came out yellow and the other orange. 811 of the 8490 systems in the
// SDE were affected, in every band from 0.1 to 0.9.
//
// Rounded with toFixed rather than Math.round so it matches the callers exactly.
// The two disagree: 0.35 is really 0.34999... in binary, which toFixed shows as
// "0.3" while Math.round(0.35 * 10) gives 4. Using the callers' own rounding
// means the digit on screen and the colour behind it can never diverge.
export function truesecColor(sec: number): string {
  const shown = Number(sec.toFixed(1));
  if (shown >= 0.9) return 'var(--cv-sec-09)';
  if (shown >= 0.8) return 'var(--cv-sec-08)';
  if (shown >= 0.7) return 'var(--cv-sec-07)';
  if (shown >= 0.6) return 'var(--cv-sec-06)';
  if (shown >= 0.5) return 'var(--cv-sec-05)';
  if (shown >= 0.4) return 'var(--cv-sec-04)';
  if (shown >= 0.3) return 'var(--cv-sec-03)';
  if (shown >= 0.2) return 'var(--cv-sec-02)';
  if (shown >= 0.1) return 'var(--cv-sec-01)';
  // Below 0.1 the raw sign still decides, unchanged: a system with a tiny
  // positive security is 0.0 space rather than negative space, and the two are
  // coloured differently.
  if (sec > 0.0) return 'var(--cv-sec-00)';
  return 'var(--cv-sec-neg)';
}
