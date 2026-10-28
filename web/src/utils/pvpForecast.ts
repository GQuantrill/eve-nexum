// The PvP forecast strip: a system's kills by UTC weekday and hour (zKill's
// ~90-day grid, or our own live-feed recording; see
// server/src/services/pvpHistory.ts), laid out as the next 24 hours starting
// from the current one, each hour read from its own weekday.

export interface PvpForecastData {
  source:    'zkill' | 'live';
  /** grid[weekday][hour], weekday 0 = Sunday, hour UTC. */
  grid:      number[][];
  total:     number;
  /** How many days the grid covers. */
  days:      number;
  /** Player kills the live feed saw here in the last 24 hours. */
  recent24h: number;
}

export interface ForecastBar {
  /** Hours from now: 0 is the current hour. */
  offset:  number;
  /** UTC weekday (0 = Sunday) and hour this bar stands for. */
  weekday: number;
  hour:    number;
  /** When the bar's hour starts, for showing it in the viewer's timezone. */
  startMs: number;
  kills:   number;
  /** kills / the busiest bar's kills, 0..1. */
  level:   number;
}

const HOUR_MS = 60 * 60 * 1000;

export function forecastBars(grid: number[][], nowMs: number): ForecastBar[] {
  const firstHour = nowMs - (((nowMs % HOUR_MS) + HOUR_MS) % HOUR_MS);
  const bars = Array.from({ length: 24 }, (_, offset) => {
    const startMs = firstHour + offset * HOUR_MS;
    const t = new Date(startMs);
    const weekday = t.getUTCDay();
    const hour = t.getUTCHours();
    return { offset, weekday, hour, startMs, kills: grid[weekday]?.[hour] ?? 0, level: 0 };
  });
  const max = Math.max(0, ...bars.map((b) => b.kills));
  if (max > 0) for (const b of bars) b.level = b.kills / max;
  return bars;
}

/** The busiest hour from now on (the earliest, on a tie), or null when none
 *  of the next 24 hours has kills on record. */
export function nextBusiest(bars: ForecastBar[]): ForecastBar | null {
  let best: ForecastBar | null = null;
  for (const b of bars) if (b.kills > 0 && (!best || b.kills > best.kills)) best = b;
  return best;
}

// ── Timezone ────────────────────────────────────────────────────────────────
// The history is counted in UTC hours; only the labels move. 'auto' is the
// browser's own zone, 'UTC' is EVE time, anything else an IANA zone name.

export type ZoneSetting = 'auto' | 'UTC' | string;

function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

/** The IANA zone a setting means. Falls back to UTC for anything unusable. */
export function resolveZone(setting: ZoneSetting | null | undefined): string {
  if (!setting || setting === 'auto') {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  }
  return validZone(setting) ? setting : 'UTC';
}

/** "19:00 GMT+1", "18:00 UTC" -- a time in the zone, with the zone named. */
export function zonedTime(ms: number, zone: string, lang: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone, timeZoneName: 'short' };
  try { return new Intl.DateTimeFormat(lang, opts).format(ms); } catch { return new Intl.DateTimeFormat('en', opts).format(ms); }
}

/** Short weekday of a moment in the zone ("Tue", "Di"). */
export function zonedWeekday(ms: number, zone: string, lang: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', timeZone: zone };
  try { return new Intl.DateTimeFormat(lang, opts).format(ms); } catch { return new Intl.DateTimeFormat('en', opts).format(ms); }
}

/** Every zone the browser knows, for the picker (empty on very old browsers). */
export function allZones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return f ? f('timeZone') : [];
  } catch {
    return [];
  }
}
