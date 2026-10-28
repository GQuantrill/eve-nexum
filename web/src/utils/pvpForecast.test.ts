import { describe, it, expect } from 'vitest';
import { forecastBars, nextBusiest, utcHourLabel } from './pvpForecast';

const byHour = (pairs: Record<number, number>) => Array.from({ length: 24 }, (_, h) => pairs[h] ?? 0);

describe('forecastBars', () => {
  it('starts at the current UTC hour and wraps past midnight', () => {
    const bars = forecastBars(byHour({ 22: 4, 1: 2 }), Date.UTC(2026, 9, 28, 21, 40));
    expect(bars).toHaveLength(24);
    expect(bars[0]).toMatchObject({ offset: 0, hour: 21, kills: 0 });
    expect(bars[1]).toMatchObject({ offset: 1, hour: 22, kills: 4, level: 1 });
    expect(bars[4]).toMatchObject({ offset: 4, hour: 1, kills: 2, level: 0.5 });
    expect(bars[23].hour).toBe(20);
  });

  it('gives every bar level 0 when nothing is on record', () => {
    expect(forecastBars(byHour({}), Date.UTC(2026, 9, 28, 3)).every((b) => b.level === 0)).toBe(true);
  });
});

describe('nextBusiest', () => {
  it('picks the busiest hour, the soonest on a tie', () => {
    const bars = forecastBars(byHour({ 18: 9, 2: 9, 12: 3 }), Date.UTC(2026, 9, 28, 10));
    expect(nextBusiest(bars)).toMatchObject({ hour: 18, offset: 8 });
  });

  it('can be the current hour', () => {
    const bars = forecastBars(byHour({ 10: 5, 11: 1 }), Date.UTC(2026, 9, 28, 10, 5));
    expect(nextBusiest(bars)).toMatchObject({ hour: 10, offset: 0 });
  });

  it('is null for a quiet system', () => {
    expect(nextBusiest(forecastBars(byHour({}), Date.UTC(2026, 9, 28, 10)))).toBeNull();
  });
});

describe('utcHourLabel', () => {
  it('pads to HH:00', () => {
    expect(utcHourLabel(3)).toBe('03:00');
    expect(utcHourLabel(18)).toBe('18:00');
  });
});
