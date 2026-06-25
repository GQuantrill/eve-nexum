// Per-system labels shown as coloured pill badges above the node. Two kinds:
//  - predefined: a fixed toggleable set (A/B/C/1/2/3), each its own colour;
//  - custom: up to MAX_CUSTOM_LABELS user entries, each free text OR a Phosphor
//    icon, encoded as 't:<text>' / 'i:<IconName>' in MapSystem.customLabels.
// Persisted via the same updateSystem path intel uses; rendered in SystemNode.

export interface LabelDef {
  id:    string;  // stored value in MapSystem.labels
  char:  string;  // pill glyph
  color: string;  // CSS var (defined in App.css)
}

// Fixed order — pills render in this order, filtered by what the system has.
export const PREDEFINED_LABELS: LabelDef[] = [
  { id: 'a', char: 'A', color: 'var(--label-a)' },
  { id: 'b', char: 'B', color: 'var(--label-b)' },
  { id: 'c', char: 'C', color: 'var(--label-c)' },
  { id: '1', char: '1', color: 'var(--label-1)' },
  { id: '2', char: '2', color: 'var(--label-2)' },
  { id: '3', char: '3', color: 'var(--label-3)' },
];

export const PREDEFINED_LABEL_IDS = PREDEFINED_LABELS.map((l) => l.id);

export const MAX_CUSTOM_LABELS = 3;

// Default custom-label pill colour when the user hasn't picked one.
export const DEFAULT_CUSTOM_LABEL_COLOR = '#3b6ea5';

export interface CustomLabel {
  kind:  'text' | 'icon';
  value: string;
  color: string;  // '#RRGGBB', or '' to fall back to the neutral pill style
}

// Encoding: `<kind>:<color>:<value>` where kind is t|i and color is '#RRGGBB'
// or empty. Value (text or icon name) may itself contain colons. Legacy
// entries written before colours existed are `<kind>:<value>` (no colour
// segment) — still parsed, with an empty colour.
export function parseCustomLabel(raw: string): CustomLabel | null {
  const kind = raw.startsWith('t:') ? 'text' : raw.startsWith('i:') ? 'icon' : null;
  if (!kind) return null;
  const rest = raw.slice(2);
  const m = rest.match(/^(#[0-9a-fA-F]{6})?:([\s\S]*)$/);
  if (m) return { kind, value: m[2], color: m[1] ?? '' };
  return { kind, value: rest, color: '' }; // legacy `<kind>:<value>`
}

export const encodeTextLabel = (text: string, color = ''): string => `t:${color}:${text}`;
export const encodeIconLabel = (iconName: string, color = ''): string => `i:${color}:${iconName}`;

// Pick black or white text for legibility on a given pill background, by
// perceived luminance (YIQ). Light backgrounds get black text, dark get white.
// The threshold leans slightly toward white so only clearly-light colours flip.
export function labelTextColor(bgHex: string): string {
  const c = bgHex.replace('#', '');
  if (c.length < 6) return '#fff';
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return '#fff';
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? '#000' : '#fff';
}
