// Colour themes. The colours themselves live in styles/themes.css, worked out
// from four seeds per theme; the seeds are repeated here only for the
// swatches in the picker. The default (nexum) is tokens.css as it is.

export const THEME_KEY = 'nexum.theme';
export const THEME_DEFAULT = 'nexum';

export interface ThemeSeeds { primary: string; highlight: string; bg: string; accent: string }

export const THEMES: { id: string; seeds: ThemeSeeds }[] = [
  { id: 'nexum',    seeds: { primary: '#3a4a6a', highlight: '#5a9af8', bg: '#0a0e1a', accent: '#5a9af8' } },
  { id: 'amarr',    seeds: { primary: '#a8916f', highlight: '#e8c872', bg: '#0c0b09', accent: '#e8955a' } },
  { id: 'caldari',  seeds: { primary: '#8fbfd8', highlight: '#5cc0b5', bg: '#090c0e', accent: '#d9953f' } },
  { id: 'gallente', seeds: { primary: '#6a9d86', highlight: '#86c2a6', bg: '#090d0b', accent: '#e8955a' } },
  { id: 'minmatar', seeds: { primary: '#c06a52', highlight: '#e0866a', bg: '#0e0a09', accent: '#e8b45a' } },
  { id: 'carbon',   seeds: { primary: '#9a9a9a', highlight: '#d8d8d8', bg: '#0a0a0a', accent: '#e8955a' } },
  { id: 'photon',   seeds: { primary: '#5c8fb3', highlight: '#6fa9d2', bg: '#0a0d11', accent: '#e8955a' } },
];

export function normaliseTheme(v: unknown): string {
  return THEMES.some((t) => t.id === v) ? (v as string) : THEME_DEFAULT;
}

/** Put the theme on <html>; the default sets nothing. */
export function applyTheme(v: unknown): void {
  const id = normaliseTheme(v);
  if (id === THEME_DEFAULT) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
}
