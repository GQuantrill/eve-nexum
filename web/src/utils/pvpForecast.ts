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
  kills:   number;
  /** kills / the busiest bar's kills, 0..1. */
  level:   number;
}

const HOUR_MS = 60 * 60 * 1000;

export function forecastBars(grid: number[][], nowMs: number): ForecastBar[] {
  const bars = Array.from({ length: 24 }, (_, offset) => {
    const t = new Date(nowMs + offset * HOUR_MS);
    const weekday = t.getUTCDay();
    const hour = t.getUTCHours();
    return { offset, weekday, hour, kills: grid[weekday]?.[hour] ?? 0, level: 0 };
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

export function utcHourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** Short weekday name in the viewer's language ("Tue", "Di", "火"). 2026-10-25
 *  was a Sunday, so day n of that week is weekday n. */
export function weekdayLabel(weekday: number, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, 9, 25 + weekday, 12));
  } catch {
    return new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, 9, 25 + weekday, 12));
  }
}
