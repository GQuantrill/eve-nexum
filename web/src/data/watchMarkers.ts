import type { WatchMarkerKind } from '../types';

// The fixed set of watchlist markers. Deliberately separate from the custom
// intel tags (those are per-system "what I found"; these are "what I'm hunting
// for"). Each marker carries a glyph (rendered on the node + in the panel), a
// ring colour for the node highlight, and an i18n label key under watchMarker.*.
export interface WatchMarkerDef {
  kind:  WatchMarkerKind;
  glyph: string;   // emoji/unicode shown on the node corner + the picker
  color: string;   // highlight ring colour (CSS var --watch-color)
}

// Order is the picker order, most-hunted first.
export const WATCH_MARKERS: WatchMarkerDef[] = [
  { kind: 'target',   glyph: '\u{1F3AF}', color: '#6ea0ff' }, // 🎯 looking for / target
  { kind: 'honeypot', glyph: '\u{1F36F}', color: '#e0a64e' }, // 🍯 honeypot / bait
  { kind: 'avoid',    glyph: '☠️', color: '#e0556e' }, // ☠️ avoid at all costs
  { kind: 'friendly', glyph: '\u{1F91D}', color: '#4ade80' }, // 🤝 friendly / staging
  { kind: 'watch',    glyph: '\u{1F441}️', color: '#67e8f9' }, // 👁️ keep an eye on
];

const BY_KIND = new Map<WatchMarkerKind, WatchMarkerDef>(WATCH_MARKERS.map((m) => [m.kind, m]));

export function watchMarker(kind: WatchMarkerKind): WatchMarkerDef {
  return BY_KIND.get(kind) ?? WATCH_MARKERS[0];
}
