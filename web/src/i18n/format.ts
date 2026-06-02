import type { TFunction } from 'i18next';

// Centralised, i18n-aware formatters. Previously these lived as near-duplicate
// helper functions scattered across Toolbar, AdminPage, SignaturePane,
// WHTypeInfo, KillboardPane, MapSidebar, etc. Keep new formatting logic here so
// the translatable strings live in one place.

// Em dash — a language-neutral "no value" placeholder.
export const DASH = '—';

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/**
 * Relative "time ago": "just now" / "12s ago" / "5m ago" / "3h ago" / "2d ago".
 * Accepts a Date or an epoch-ms number. For callers that want an absolute date
 * past some age, branch on the age yourself and fall back to europeanDate().
 */
export function timeAgo(t: TFunction, when: Date | number): string {
  const ms = when instanceof Date ? when.getTime() : when;
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 5)     return t('time.justNow');
  if (secs < 60)    return t('time.secondsAgo', { value: secs });
  if (secs < 3600)  return t('time.minutesAgo', { value: Math.floor(secs / 60) });
  if (secs < 86400) return t('time.hoursAgo',   { value: Math.floor(secs / 3600) });
  return t('time.daysAgo', { value: Math.floor(secs / 86400) });
}

/** DD-MM-YYYY. Numeric, so not translated. */
export function europeanDate(date: Date): string {
  return `${pad2(date.getDate())}-${pad2(date.getMonth() + 1)}-${date.getFullYear()}`;
}

/**
 * Elapsed duration (counting up): "0s" / "42s" / "5m 03s" / "2h 09m" /
 * "3d 02h 09m" once past 24h. Negative inputs clamp to 0.
 */
export function duration(t: TFunction, totalSeconds: number): string {
  const s = totalSeconds < 0 ? 0 : totalSeconds;
  if (s < 60) return t('duration.seconds', { value: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('duration.minutesSeconds', { minutes: m, seconds: pad2(s % 60) });
  const h = Math.floor(m / 60);
  if (h < 24) return t('duration.hoursMinutes', { hours: h, minutes: pad2(m % 60) });
  const d = Math.floor(h / 24);
  return t('duration.daysHoursMinutes', { days: d, hours: pad2(h % 24), minutes: pad2(m % 60) });
}

/** "expires in 2h 14m" / "expires in 14m" / "expired" from a millisecond remainder. */
export function expiresIn(t: TFunction, ms: number): string {
  if (ms <= 0) return t('share.expired');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0
    ? t('share.expiresInHM', { hours: h, minutes: m })
    : t('share.expiresInM', { minutes: m });
}

/** Wormhole mass: "1.44 B kg" / "500 M kg" / "123,456 kg" / em dash for <= 0. */
export function mass(t: TFunction, kg: number): string {
  if (kg >= 1_000_000_000) return t('mass.billionKg', { value: (kg / 1_000_000_000).toFixed(2) });
  if (kg >= 1_000_000)     return t('mass.millionKg', { value: (kg / 1_000_000).toFixed(0) });
  if (kg > 0)              return t('mass.kg',        { value: kg.toLocaleString() });
  return DASH;
}

/** Compact ISK/number abbreviation: "2.5B" / "500M" / "12K" / "640". Suffixes are universal, no translation. */
export function abbreviateValue(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
}

/** Pluralised jump count: "1 jump" / "3 jumps". */
export function jumps(t: TFunction, n: number): string {
  return t('units.jumps', { count: n });
}
