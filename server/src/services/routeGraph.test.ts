import { describe, it, expect, beforeEach } from 'vitest';
import { setRouteGraphForTest, shortestRoutes } from './routeGraph.js';

// A - B - C - D, with a longer way round A - E - F - G - D.
const EDGES: [number, number][] = [[1, 2], [2, 3], [3, 4], [1, 5], [5, 6], [6, 7], [7, 4]];
const names = ['', 'A', 'Uedama', 'C', 'D', 'E', 'F', 'G'];

beforeEach(() => {
  const adj = new Map<number, number[]>();
  for (const [a, b] of EDGES) {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  const info = new Map(names.slice(1).map((name, i) => [i + 1, { name, security: 0.5 }]));
  setRouteGraphForTest(adj, info);
});

const ids = (r: Awaited<ReturnType<typeof shortestRoutes>>, t: number) => r[t]?.path.map((n) => n.id);

describe('shortestRoutes avoidance', () => {
  it('takes the short way with nothing avoided', async () => {
    expect(ids(await shortestRoutes(1, [4]), 4)).toEqual([1, 2, 3, 4]);
  });

  it('goes the long way round an avoided system', async () => {
    for (const mode of ['shortest', 'secure'] as const) {
      const r = await shortestRoutes(1, [4], mode, undefined, new Set([2]));
      expect(ids(r, 4)).toEqual([1, 5, 6, 7, 4]);
      expect(r[4].jumps).toBe(4);
    }
  });

  it('still routes to an avoided system you asked for', async () => {
    expect(ids(await shortestRoutes(1, [2], 'shortest', undefined, new Set([2])), 2)).toEqual([1, 2]);
  });

  it('still routes out of an avoided system you are in', async () => {
    expect(ids(await shortestRoutes(2, [3], 'shortest', undefined, new Set([2])), 3)).toEqual([2, 3]);
  });

  it('returns no route when every way is avoided', async () => {
    expect(await shortestRoutes(1, [4], 'shortest', undefined, new Set([2, 6]))).toEqual({});
  });
});

describe('secure routes through Thera', () => {
  // A (HS) - 20 HS jumps - Z, or A - B (HS) - Thera - C (HS) - Z. And a
  // null-sec exit N off Thera that a secure route still keeps out of.
  const THERA = 99;
  beforeEach(() => {
    const adj = new Map<number, number[]>();
    const info = new Map<number, { name: string; security: number }>();
    const link = (a: number, b: number) => {
      adj.set(a, [...(adj.get(a) ?? []), b]);
      adj.set(b, [...(adj.get(b) ?? []), a]);
    };
    for (let i = 1; i <= 21; i++) info.set(i, { name: `S${i}`, security: 0.9 });
    for (let i = 1; i < 21; i++) link(i, i + 1);           // 1 .. 21, 20 jumps
    info.set(30, { name: 'B', security: 0.9 }); link(1, 30);
    info.set(31, { name: 'C', security: 0.9 }); link(31, 21);
    info.set(40, { name: 'N', security: -0.3 });
    adj.set(40, []);
    setRouteGraphForTest(adj, info);
  });
  const overlay = (exits: number[]) => {
    const o = { adj: new Map<number, number[]>(), info: new Map([[THERA, { name: 'Thera', security: -0.99 }]]), edgeMeta: new Map() };
    for (const e of exits) {
      o.adj.set(THERA, [...(o.adj.get(THERA) ?? []), e]);
      o.adj.set(e, [...(o.adj.get(e) ?? []), THERA]);
      o.edgeMeta.set(`${THERA}|${e}`, { kind: 'thera' });
      o.edgeMeta.set(`${e}|${THERA}`, { kind: 'thera' });
    }
    return o;
  };

  it('takes a high-sec Thera route when it is shorter', async () => {
    const r = await shortestRoutes(1, [21], 'secure', overlay([30, 31]));
    expect(ids(r, 21)).toEqual([1, 30, THERA, 31, 21]);
  });

  it('keeps the gates when Thera is no shorter', async () => {
    const r = await shortestRoutes(1, [3], 'secure', overlay([30, 31]));
    expect(ids(r, 3)).toEqual([1, 2, 3]);
  });

  it('still keeps out of a null-sec exit', async () => {
    const r = await shortestRoutes(30, [40], 'secure', overlay([30, 40]));
    expect(ids(r, 40)).toEqual([30, THERA, 40]); // the only way, so taken
    const r2 = await shortestRoutes(1, [21], 'secure', overlay([30, 40]));
    expect(ids(r2, 21)).toHaveLength(21);         // no high-sec exit near Z
  });
});
