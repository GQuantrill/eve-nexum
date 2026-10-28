import { describe, it, expect } from 'vitest';
import { parseZkillActivity } from './zkillActivity.js';

describe('parseZkillActivity', () => {
  it('reads weekdays given as 24-entry lists', () => {
    const row = Array.from({ length: 24 }, (_, h) => h);
    const grid = parseZkillActivity({ max: 23, 0: row, days: ['Sun'] });
    expect(grid).toHaveLength(7);
    expect(grid[0]).toEqual(row);
    expect(grid[1]).toEqual(new Array(24).fill(0));
  });

  it('reads weekdays given as objects keyed by the hours that had kills', () => {
    const grid = parseZkillActivity({ 3: { 0: 5, 18: 41, 23: '2' } });
    expect(grid[3][0]).toBe(5);
    expect(grid[3][18]).toBe(41);
    expect(grid[3][23]).toBe(2);
    expect(grid[3][1]).toBe(0);
  });

  it('turns anything malformed into zeros', () => {
    expect(parseZkillActivity(null).flat().every((n) => n === 0)).toBe(true);
    expect(parseZkillActivity('nope').flat().every((n) => n === 0)).toBe(true);
    const grid = parseZkillActivity({ 0: [-4, 'x', 2.7, null], 1: 'bad', 9: [99] });
    expect(grid[0].slice(0, 4)).toEqual([0, 0, 2, 0]);
    expect(grid[1].every((n) => n === 0)).toBe(true);
  });
});
