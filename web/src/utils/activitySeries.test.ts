import { describe, it, expect } from 'vitest';
import { peakOf, normaliseSeries, alignHourly } from './activitySeries';

describe('peakOf', () => {
  it('is the largest value', () => {
    expect(peakOf([3, 17, 5])).toBe(17);
  });
  it('is 0 for an empty or all-zero series', () => {
    expect(peakOf([])).toBe(0);
    expect(peakOf([0, 0, 0])).toBe(0);
  });
});

describe('normaliseSeries', () => {
  it('scales against the series own peak', () => {
    expect(normaliseSeries([0, 5, 10])).toEqual([0, 0.5, 1]);
  });

  it('flattens an all-zero series instead of dividing by zero', () => {
    expect(normaliseSeries([0, 0, 0])).toEqual([0, 0, 0]);
    expect(normaliseSeries([])).toEqual([]);
  });

  it('makes a small series readable beside a huge one -- the whole point', () => {
    // Jita's real shape: ~3400 jumps/hr against ~19 pod kills.
    const jumps = [3371, 1700, 850];
    const pods  = [19, 10, 5];
    const [nj, np] = [normaliseSeries(jumps), normaliseSeries(pods)];
    // Both peak at the top of the plot, so both are visible...
    expect(nj[0]).toBe(1);
    expect(np[0]).toBe(1);
    // ...and the pod series is nowhere near the floor it would sit on if the
    // two shared an absolute axis (19/3371 = 0.006).
    expect(np[2]).toBeGreaterThan(0.25);
  });

  it('keeps shape comparable: a series and its multiple normalise identically', () => {
    expect(normaliseSeries([1, 2, 4])).toEqual(normaliseSeries([100, 200, 400]));
  });
});

describe('alignHourly', () => {
  const H = 3_600_000;
  const now = Date.parse('2026-10-29T10:09:06Z');       // CCP's latest cut was 09:15
  const h = (iso: string) => Date.parse(iso);
  const pt = (hour: number, shipKills: number) => ({ hour, jumps: 0, shipKills, podKills: 0, npcKills: 0 });

  it("ends last hour, not 'this hour', when that is CCP's newest", () => {
    const { points, lag } = alignHourly([pt(h('2026-10-29T07:00:00Z'), 2), pt(h('2026-10-29T08:00:00Z'), 5)], 24, now);
    expect(points.map((p) => p.shipKills)).toEqual([2, 5]);
    expect(lag).toBe(2); // 08:00 is two hours before the 10:00 slot
  });

  it('fills an hour with no row as zero instead of closing the gap', () => {
    const { points, lag } = alignHourly([pt(h('2026-10-29T06:00:00Z'), 3), pt(h('2026-10-29T09:00:00Z'), 1)], 24, now);
    expect(points.map((p) => p.shipKills)).toEqual([3, 0, 0, 1]);
    expect(lag).toBe(1);
  });

  it('drops anything older than the window and copes with no data', () => {
    expect(alignHourly([pt(h('2026-10-29T10:00:00Z') - 30 * H, 9)], 24, now)).toEqual({ points: [], lag: 0 });
    expect(alignHourly([], 24, now)).toEqual({ points: [], lag: 0 });
  });

  it('puts a current-hour point at the right edge', () => {
    expect(alignHourly([pt(h('2026-10-29T10:00:00Z'), 4)], 24, now).lag).toBe(0);
  });
});
