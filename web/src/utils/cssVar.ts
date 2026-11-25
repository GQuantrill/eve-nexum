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

/** Any CSS colour, var() and color-mix() included, as #rrggbb: what the page
 *  would paint. For <input type="color">, which only takes hex. Falls back to
 *  `fallback` outside a browser or if the colour can't be read. */
export function resolveColorHex(color: string, fallback = '#000000'): string {
  try {
    const el = document.createElement('span');
    el.style.color = color;
    el.style.display = 'none';
    document.body.appendChild(el);
    const computed = getComputedStyle(el).color;
    el.remove();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return fallback;
  }
}
