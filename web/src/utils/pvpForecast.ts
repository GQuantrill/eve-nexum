// The PvP forecast strip: a system's kills by UTC hour of day (summed over the
// server's history window, see server/src/services/pvpHistory.ts), laid out as
// the next 24 hours starting from the current one.

export interface PvpForecastData {
  byHour: number[]; // 24 entries, index = UTC hour of day
  total:  number;
  days:   number;   // how many days of history the counts cover
}

export interface ForecastBar {
  /** Hours from now: 0 is the current hour. */
  offset: number;
  /** UTC hour of day this bar stands for. */
  hour:   number;
  kills:  number;
  /** kills / the busiest hour's kills, 0..1. */
  level:  number;
}

export function forecastBars(byHour: number[], nowMs: number): ForecastBar[] {
  const start = new Date(nowMs).getUTCHours();
  const max = Math.max(0, ...byHour);
  return Array.from({ length: 24 }, (_, offset) => {
    const hour = (start + offset) % 24;
    const kills = byHour[hour] ?? 0;
    return { offset, hour, kills, level: max > 0 ? kills / max : 0 };
  });
}

/** The busiest hour from now on (the earliest, on a tie), or null when the
 *  system has no PvP on record. */
export function nextBusiest(bars: ForecastBar[]): ForecastBar | null {
  let best: ForecastBar | null = null;
  for (const b of bars) if (b.kills > 0 && (!best || b.kills > best.kills)) best = b;
  return best;
}

export function utcHourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}
