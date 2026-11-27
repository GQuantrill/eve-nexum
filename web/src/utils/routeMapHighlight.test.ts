import { describe, it, expect } from 'vitest';
import { routeMapHighlight } from './routeMapHighlight';

const node = (id: number) => ({ id, name: String(id), security: 0, kspace: true });
const route = (...ids: number[]) => ({ jumps: ids.length - 1, path: ids.map(node), usesSpecial: false });

const systems = [
  { id: 'a', eveSystemId: 1 }, { id: 'b', eveSystemId: 2 }, { id: 'c', eveSystemId: 3 },
  { id: 'x', eveSystemId: 9 }, { id: 'u', eveSystemId: null },
];
const connections = [
  { id: 'ab', sourceId: 'a', targetId: 'b' },
  { id: 'cb', sourceId: 'c', targetId: 'b' },   // either direction
  { id: 'ax', sourceId: 'a', targetId: 'x' },   // not on the route
  { id: 'ac', sourceId: 'a', targetId: 'c' },   // both ends on the route, but not a hop of it
];

describe('routeMapHighlight', () => {
  it('lights the route systems on the map and the links it takes', () => {
    expect(routeMapHighlight(route(1, 2, 3, 4), systems, connections))
      .toEqual({ systemIds: ['a', 'b', 'c'], connectionIds: ['ab', 'cb'] });
  });

  it('is null when none of the route is on the map', () => {
    expect(routeMapHighlight(route(5, 6), systems, connections)).toBeNull();
  });
});
