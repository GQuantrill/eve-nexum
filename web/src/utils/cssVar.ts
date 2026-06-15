// Resolve a `var(--x)` expression to its computed colour. Needed where a colour
// is consumed somewhere CSS custom properties don't apply — notably the
// react-flow MiniMap, which paints to a <canvas> and so can't read `var()`.
// Plain colour strings (hex/rgb) pass straight through.
export function cssVarToHex(value: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!m) return value;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  return resolved || value;
}
