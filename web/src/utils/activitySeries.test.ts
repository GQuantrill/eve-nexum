import { describe, it, expect } from 'vitest';
import { peakOf, normaliseSeries } from './activitySeries';

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
