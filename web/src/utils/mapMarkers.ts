// The home and you-are-here markers on map nodes: their colours and how hard
// the you-are-here ring pulses. Chosen in Settings > Display and applied as
// CSS variables on <html> (App.tsx), which styles/system-node.css reads.

export const HOME_COLOR_KEY  = 'nexum.map.homeColor';
export const HERE_COLOR_KEY  = 'nexum.map.hereColor';
export const HERE_PULSE_KEY  = 'nexum.map.herePulse';

export const HOME_COLOR_DEFAULT = '#f0c040'; // --warning-gold
export const HERE_COLOR_DEFAULT = '#3ddc84'; // --success

export type HerePulse = 'off' | 'subtle' | 'normal' | 'strong';
export const HERE_PULSES: HerePulse[] = ['off', 'subtle', 'normal', 'strong'];
export const HERE_PULSE_DEFAULT: HerePulse = 'normal';

// How far the ring travels (px) and how strong it starts (%). 'off' keeps a
// still ring so the node is still marked.
const PULSE: Record<HerePulse, { spread: number; alpha: number; anim: boolean }> = {
  off:    { spread: 4,  alpha: 70,  anim: false },
  subtle: { spread: 8,  alpha: 45,  anim: true },
  normal: { spread: 16, alpha: 80,  anim: true },
  strong: { spread: 26, alpha: 100, anim: true },
};

// Only a plain #rrggbb reaches the stylesheet; anything else falls back.
export function safeColor(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

export function normalisePulse(v: unknown): HerePulse {
  return HERE_PULSES.includes(v as HerePulse) ? (v as HerePulse) : HERE_PULSE_DEFAULT;
}

export function applyMapMarkers(homeColor: unknown, hereColor: unknown, pulse: unknown): void {
  const s = document.documentElement.style;
  const p = PULSE[normalisePulse(pulse)];
  s.setProperty('--home-color', safeColor(homeColor, HOME_COLOR_DEFAULT));
  s.setProperty('--here-color', safeColor(hereColor, HERE_COLOR_DEFAULT));
  s.setProperty('--here-spread', `${p.spread}px`);
  s.setProperty('--here-alpha', `${p.alpha}%`);
  document.documentElement.dataset.herePulse = p.anim ? 'on' : 'off';
}
