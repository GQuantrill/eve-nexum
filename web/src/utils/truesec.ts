// Returns a CSS custom property so the colour-vision palettes (the --cv-sec-*
// vars in App.css) can re-map the security gradient per mode.
export function truesecColor(sec: number): string {
  if (sec >= 0.9) return 'var(--cv-sec-09)';
  if (sec >= 0.8) return 'var(--cv-sec-08)';
  if (sec >= 0.7) return 'var(--cv-sec-07)';
  if (sec >= 0.6) return 'var(--cv-sec-06)';
  if (sec >= 0.5) return 'var(--cv-sec-05)';
  if (sec >= 0.4) return 'var(--cv-sec-04)';
  if (sec >= 0.3) return 'var(--cv-sec-03)';
  if (sec >= 0.1) return 'var(--cv-sec-01)';
  if (sec >  0.0) return 'var(--cv-sec-00)';
  return 'var(--cv-sec-neg)';
}
