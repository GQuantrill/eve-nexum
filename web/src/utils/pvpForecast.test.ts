import { describe, it, expect } from 'vitest';
import { forecastBars, nextBusiest, utcHourLabel, weekdayLabel } from './pvpForecast';

// A grid with the given [weekday, hour, kills] cells set.
const grid = (cells: Array<[number, number, number]>) => {
  const g = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const [d, h, n] of cells) g[d][h] = n;
  return g;
};

// Wednesday 28 Oct 2026, 21:40 UTC.
const WED_2140 = Date.UTC(2026, 9, 28, 21, 40);

describe('forecastBars', () => {
  it("starts at the current UTC hour and reads each hour from its own weekday", () => {
    // Wed 22:00 and Thu 01:00 are ahead; Wed 01:00 is behind us and must not show.
    const bars = forecastBars(grid([[3, 22, 4], [4, 1, 2], [3, 1, 99]]), WED_2140);
    expect(bars).toHaveLength(24);
    expect(bars[0]).toMatchObject({ offset: 0, weekday: 3, hour: 21, kills: 0 });
    expect(bars[1]).toMatchObject({ offset: 1, weekday: 3, hour: 22, kills: 4, level: 1 });
    expect(bars[4]).toMatchObject({ offset: 4, weekday: 4, hour: 1, kills: 2, level: 0.5 });
    expect(bars[23]).toMatchObject({ weekday: 4, hour: 20 });
  });

  it('gives every bar level 0 when nothing is on record', () => {
    expect(forecastBars(grid([]), WED_2140).every((b) => b.level === 0)).toBe(true);
  });
});

describe('nextBusiest', () => {
  it('picks the busiest hour, the soonest on a tie', () => {
    const bars = forecastBars(grid([[4, 2, 9], [3, 23, 9], [4, 12, 3]]), WED_2140);
    expect(nextBusiest(bars)).toMatchObject({ weekday: 3, hour: 23, offset: 2 });
  });

  it('can be the current hour', () => {
    expect(nextBusiest(forecastBars(grid([[3, 21, 5]]), WED_2140))).toMatchObject({ offset: 0 });
  });

  it('is null for a quiet system', () => {
    expect(nextBusiest(forecastBars(grid([]), WED_2140))).toBeNull();
  });
});

describe('labels', () => {
  it('pads the hour', () => {
    expect(utcHourLabel(3)).toBe('03:00');
    expect(utcHourLabel(18)).toBe('18:00');
  });

  it('names the weekday in the given language', () => {
    expect(weekdayLabel(0, 'en')).toBe('Sun');
    expect(weekdayLabel(3, 'en')).toBe('Wed');
    expect(weekdayLabel(1, 'de')).toMatch(/^Mo/);
  });
});
