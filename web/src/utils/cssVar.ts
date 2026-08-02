// Resolve a `var(--x)` expression to its computed colour. Needed where a colour
// is consumed somewhere CSS custom properties don't apply — notably the
// react-flow MiniMap, which paints to a <canvas> and so can't read `var()`.
// Plain colour strings (hex/rgb) pass straight through.
export function cssVarToHex(value: string | null | undefined): string {
  // A missing/corrupt colour must never throw — the MiniMap's nodeColor paints
  // during React render, so one bad value (e.g. a system with an unknown
  // systemClass, so CLASS_COLORS[...] is undefined) would crash the whole map to
  // a black screen. Fall back to a neutral grey instead.
  if (typeof value !== 'string' || value === '') return '#666';
  const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!m) return value;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  return resolved || value;
}
