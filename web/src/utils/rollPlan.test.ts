import { describe, it, expect } from 'vitest';
import { planPasses, nextShipName, type RollPlan } from './rollPlan';

const M = 1_000_000;
const bs1 = { id: 'a', name: 'BS 1', coldKg: 100 * M, hotKg: 200 * M };
const bs2 = { id: 'b', name: 'BS 2', coldKg: 100 * M, hotKg: 200 * M };
const hic = { id: 'h', name: 'HIC 1', coldKg: 15 * M, hotKg: 22 * M };
const line = (id: string, shipId: string, hot: boolean, done = false) => ({ id, shipId, hot, done });

describe('rolling plan', () => {
  it("gives each ship its own out and back, and a running total", () => {
    const plan: RollPlan = {
      ships: [bs1, bs2],
      lines: [line('1', 'a', true), line('2', 'b', true), line('3', 'a', false), line('4', 'b', false)],
    };
    const p = planPasses(2000 * M, 0, plan);
    expect(p.map((x) => x.out)).toEqual([true, true, false, false]);
    expect(p.map((x) => x.usedAfter! / M)).toEqual([200, 400, 500, 600]);
    expect(p.every((x) => x.outcome === 'safe')).toBe(true);
  });

  it('starts from the mass already used and skips flown passes', () => {
    const plan: RollPlan = { ships: [bs1], lines: [line('1', 'a', true, true), line('2', 'a', true)] };
    const p = planPasses(2000 * M, 200 * M, plan);
    expect(p[0].usedAfter).toBeNull();
    expect(p[1].out).toBe(false);
    expect(p[1].usedAfter! / M).toBe(400);
  });

  it('flags a pass that could close the hole with the ship on the far side', () => {
    // 1000M hole: worst case 900M. 800M used; a hot BS out could close it.
    const plan: RollPlan = { ships: [bs1, hic], lines: [line('1', 'a', true), line('2', 'h', false)] };
    const p = planPasses(1000 * M, 800 * M, plan);
    expect(p[0].outcome).not.toBe('safe');
    expect(p[0].strands).toBe(true);
  });

  it('does not flag closing it on the way back', () => {
    const plan: RollPlan = { ships: [bs1], lines: [line('1', 'a', false, true), line('2', 'a', true)] };
    const p = planPasses(1000 * M, 950 * M, plan);
    expect(p[1].out).toBe(false);
    expect(p[1].outcome).toBe('collapse');
    expect(p[1].strands).toBe(false);
  });

  it('numbers ships', () => {
    expect(nextShipName('BS', [bs1])).toBe('BS 2');
    expect(nextShipName('BS', [bs2])).toBe('BS 1');
  });
});
