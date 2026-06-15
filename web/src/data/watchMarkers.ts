import { type Icon, TargetIcon, MagnetIcon, SkullIcon, HandshakeIcon, EyeIcon } from '@phosphor-icons/react';
import type { WatchMarkerKind } from '../types';

// The single source of truth for watchlist markers. Deliberately separate from
// the custom intel tags (those are per-system "what I found"; these are "what
// I'm hunting for"). Each marker maps to a vendored Phosphor icon (NOT an
// emoji — emoji render per-OS/browser) plus a highlight colour. Both the
// watchlist panel and the map node read from here, so there's one definition.
export interface WatchMarkerDef {
  kind:  WatchMarkerKind;
  Icon:  Icon;
  color: string;   // highlight ring colour (CSS var --watch-color) + icon tint
}

// Order is the picker order, most-hunted first. Colours are CSS custom
// properties (--cv-watch-* in App.css) so they re-map per colour-vision mode;
// consumed in DOM styles / filter strings, so var() resolves.
export const WATCH_MARKERS: WatchMarkerDef[] = [
  { kind: 'target',   Icon: TargetIcon,    color: 'var(--cv-watch-target)' },   // looking for / target
  { kind: 'honeypot', Icon: MagnetIcon,    color: 'var(--cv-watch-honeypot)' }, // honeypot / bait (lures them in)
  { kind: 'avoid',    Icon: SkullIcon,     color: 'var(--cv-watch-avoid)' },    // avoid at all costs
  { kind: 'friendly', Icon: HandshakeIcon, color: 'var(--cv-watch-friendly)' }, // friendly / staging
  { kind: 'watch',    Icon: EyeIcon,       color: 'var(--cv-watch-watch)' },    // keep an eye on
];

const BY_KIND = new Map<WatchMarkerKind, WatchMarkerDef>(WATCH_MARKERS.map((m) => [m.kind, m]));

export function watchMarker(kind: WatchMarkerKind): WatchMarkerDef {
  return BY_KIND.get(kind) ?? WATCH_MARKERS[0];
}
