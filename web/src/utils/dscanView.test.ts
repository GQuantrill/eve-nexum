import { describe, it, expect } from 'vitest';
import { breakdown, localBreakdown, SCAN_ROUTE_RE, type DscanData, type LocalData } from './dscanView';

const scan: DscanData = {
  kind: 'dscan', onGridKm: 10_000,
  types: {
    1: { n: 'Tengu',    g: 'Strategic Cruiser', s: 'ship',       m: 8_000_000 },
    2: { n: 'Loki',     g: 'Strategic Cruiser', s: 'ship',       m: 9_000_000 },
    3: { n: 'Avatar',   g: 'Titan',             s: 'ship',       m: 2_000_000_000 },
    4: { n: 'Astrahus', g: 'Citadel',           s: 'structure',  m: 1 },
    5: { n: 'Mystery',  g: '',                  s: 'ship',       m: null },
    6: { n: 'Moon',     g: 'Moon',              s: 'other',      m: null },
  },
  rows: [
    [1, 'a', 1_000], [1, 'b', 2_000], [2, 'c', 3_000],
    [3, 'd', 600_000_000], [4, 'e', 5_000], [5, 'f', 50], [6, 'g', null],
  ],
};

describe('breakdown', () => {
  it('groups ships by class, busiest first, and types within', () => {
    const b = breakdown(scan);
    expect(b.total).toBe(7);
    expect(b.sectionTotals).toEqual({ ship: 5, structure: 1, deployable: 0, drone: 0, other: 1 });
    expect(b.sections.ship.map((g) => [g.group, g.count])).toEqual([
      ['Strategic Cruiser', 3], ['', 1], ['Titan', 1],
    ]);
    expect(b.sections.ship[0].types.map((x) => [x.name, x.count])).toEqual([['Tengu', 2], ['Loki', 1]]);
  });

  it('sums hull mass and flags ships it could not weigh', () => {
    const b = breakdown(scan);
    expect(b.shipMass).toBe(8_000_000 * 2 + 9_000_000 + 2_000_000_000);
    expect(b.shipsWithoutMass).toBe(1);
  });

  it('splits on grid from off grid, a missing distance counting as off', () => {
    const on = breakdown(scan, 'on');
    expect(on.total).toBe(5);
    expect(on.sections.ship.find((g) => g.group === 'Titan')).toBeUndefined();
    expect(on.shipMass).toBe(25_000_000);
    const off = breakdown(scan, 'off');
    expect(off.total).toBe(2);
    expect([on.onGrid, on.offGrid]).toEqual([5, 2]);
  });
});

describe('localBreakdown', () => {
  const local: LocalData = {
    kind: 'local', unknown: [],
    names: { 10: 'Corp A', 11: 'Corp B', 12: 'Corp C', 20: 'Alliance X' },
    pilots: [
      { n: 'p1', id: 1, c: 10, a: 20 }, { n: 'p2', id: 2, c: 10, a: 20 },
      { n: 'p3', id: 3, c: 11, a: 20 }, { n: 'p4', id: 4, c: 12, a: null },
      { n: 'p5', id: 5, c: 12, a: null }, { n: 'p6', id: 6, c: 12, a: null },
      { n: 'p7', id: 7, c: 99, a: 77 },
    ],
  };

  it('groups by alliance then corp, with no-alliance last', () => {
    const out = localBreakdown(local);
    expect(out.map((a) => [a.name, a.count])).toEqual([['Alliance X', 3], ['#77', 1], ['', 3]]);
    expect(out[0].corps.map((c) => [c.name, c.count])).toEqual([['Corp A', 2], ['Corp B', 1]]);
    expect(out[2].id).toBeNull();
  });
});

describe('SCAN_ROUTE_RE', () => {
  it('matches the new-scan and view routes only', () => {
    expect(SCAN_ROUTE_RE.exec('/dscan')?.[1]).toBeUndefined();
    expect(SCAN_ROUTE_RE.test('/dscan')).toBe(true);
    expect(SCAN_ROUTE_RE.exec('/dscan/AbCdEfGh_-123456')?.[1]).toBe('AbCdEfGh_-123456');
    expect(SCAN_ROUTE_RE.test('/dscan/short')).toBe(false);
    expect(SCAN_ROUTE_RE.test('/dscanx')).toBe(false);
  });
});
