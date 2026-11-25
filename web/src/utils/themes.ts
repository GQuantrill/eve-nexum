// Colour themes. The colours themselves live in styles/themes.css, worked out
// from four seeds per theme; the preset seeds are repeated here for the
// swatches in the picker. The default (nexum) is tokens.css as it is.
//
// A pilot's own themes (CUSTOM_THEMES_KEY, synced) are the same four seeds:
// picking one sets data-theme="custom" and puts its seeds on <html> inline,
// and themes.css derives everything else exactly as for a preset.

export const THEME_KEY = 'nexum.theme';
export const THEME_DEFAULT = 'nexum';
export const CUSTOM_THEMES_KEY = 'nexum.customThemes';
export const MAX_CUSTOM_THEMES = 10;
export const MAX_THEME_NAME = 30;

export interface ThemeSeeds { primary: string; highlight: string; bg: string; accent: string }
export interface CustomTheme { id: string; name: string; seeds: ThemeSeeds }

export const SEED_KEYS: (keyof ThemeSeeds)[] = ['primary', 'highlight', 'bg', 'accent'];

export const THEMES: { id: string; seeds: ThemeSeeds }[] = [
  { id: 'nexum',    seeds: { primary: '#3a4a6a', highlight: '#5a9af8', bg: '#0a0e1a', accent: '#5a9af8' } },
  { id: 'amarr',    seeds: { primary: '#a8916f', highlight: '#e8c872', bg: '#0c0b09', accent: '#e8955a' } },
  { id: 'caldari',  seeds: { primary: '#8fbfd8', highlight: '#5cc0b5', bg: '#090c0e', accent: '#d9953f' } },
  { id: 'gallente', seeds: { primary: '#6a9d86', highlight: '#86c2a6', bg: '#090d0b', accent: '#e8955a' } },
  { id: 'minmatar', seeds: { primary: '#c06a52', highlight: '#e0866a', bg: '#0e0a09', accent: '#e8b45a' } },
  { id: 'carbon',   seeds: { primary: '#9a9a9a', highlight: '#d8d8d8', bg: '#0a0a0a', accent: '#e8955a' } },
  { id: 'photon',   seeds: { primary: '#5c8fb3', highlight: '#6fa9d2', bg: '#0a0d11', accent: '#e8955a' } },
];

const HEX = /^#[0-9a-f]{6}$/i;
const CUSTOM_ID = /^[a-z0-9]{1,16}$/;
/** The theme setting's value for a custom theme. */
export const customThemeValue = (id: string): string => `custom:${id}`;

/** The stored list, keeping only well-formed entries (it is synced, so it may
 *  have been written by an older or newer client). */
export function parseCustomThemes(v: unknown): CustomTheme[] {
  if (!Array.isArray(v)) return [];
  const out: CustomTheme[] = [];
  for (const t of v) {
    if (!t || typeof t !== 'object') continue;
    const { id, name, seeds } = t as Partial<CustomTheme>;
    if (typeof id !== 'string' || !CUSTOM_ID.test(id) || out.some((o) => o.id === id)) continue;
    if (!seeds || !SEED_KEYS.every((k) => typeof seeds[k] === 'string' && HEX.test(seeds[k]))) continue;
    out.push({ id, name: typeof name === 'string' ? name.slice(0, MAX_THEME_NAME) : '', seeds: { ...seeds } });
    if (out.length >= MAX_CUSTOM_THEMES) break;
  }
  return out;
}

export function newCustomThemeId(): string {
  return Math.random().toString(36).slice(2, 10) || 'theme';
}

/** What the theme setting points at: a preset id, a custom theme, or the
 *  default when it points at nothing (a deleted custom theme, say). */
export function resolveTheme(v: unknown, customs: CustomTheme[]):
  { kind: 'preset'; id: string } | { kind: 'custom'; theme: CustomTheme } {
  if (typeof v === 'string' && v.startsWith('custom:')) {
    const theme = customs.find((c) => customThemeValue(c.id) === v);
    if (theme) return { kind: 'custom', theme };
  }
  return { kind: 'preset', id: THEMES.some((t) => t.id === v) ? (v as string) : THEME_DEFAULT };
}

/** The setting value the picker should show as chosen. */
export function normaliseTheme(v: unknown, customs: CustomTheme[] = []): string {
  const r = resolveTheme(v, customs);
  return r.kind === 'custom' ? customThemeValue(r.theme.id) : r.id;
}

const SEED_VARS: Record<keyof ThemeSeeds, string> = {
  primary: '--th-primary', highlight: '--th-highlight', bg: '--th-bg', accent: '--th-accent',
};

/** Put a theme on <html>: a preset by name, or custom seeds inline. The
 *  default sets nothing. */
export function applySeeds(seeds: ThemeSeeds | null, presetId = THEME_DEFAULT): void {
  const root = document.documentElement;
  for (const k of SEED_KEYS) root.style.removeProperty(SEED_VARS[k]);
  if (seeds) {
    root.dataset.theme = 'custom';
    for (const k of SEED_KEYS) root.style.setProperty(SEED_VARS[k], seeds[k]);
  } else if (presetId === THEME_DEFAULT) {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = presetId;
  }
}

export function applyTheme(v: unknown, customs: CustomTheme[] = []): void {
  const r = resolveTheme(v, customs);
  if (r.kind === 'custom') applySeeds(r.theme.seeds);
  else applySeeds(null, r.id);
}

/** Seeds to start a new theme from: the current one's. */
export function seedsOf(v: unknown, customs: CustomTheme[]): ThemeSeeds {
  const r = resolveTheme(v, customs);
  return { ...(r.kind === 'custom' ? r.theme.seeds : THEMES.find((t) => t.id === r.id)!.seeds) };
}

/** Relative luminance (WCAG), 0 black to 1 white. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((u) => (u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** nexum's text is light, so a theme's background has to stay dark. */
export const MAX_BG_LUMINANCE = 0.03;
