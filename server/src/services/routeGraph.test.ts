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
