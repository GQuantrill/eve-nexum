import { describe, it, expect, beforeEach } from 'vitest';
import { setRouteGraphForTest, nearestRoutes } from './routeGraph.js';
import { npcBuyers, type MarketOrder } from './blueLoot.js';

// A line: 1 - 2 - 3 - 4 - 5 - 6
beforeEach(() => {
  const adj = new Map<number, number[]>();
  for (let i = 1; i < 6; i++) {
    adj.set(i, [...(adj.get(i) ?? []), i + 1]);
    adj.set(i + 1, [...(adj.get(i + 1) ?? []), i]);
  }
  const info = new Map([1, 2, 3, 4, 5, 6].map((id) => [id, { name: `S${id}`, security: 0.5 }]));
  setRouteGraphForTest(adj, info);
});

describe('nearestRoutes', () => {
  it('returns the closest few, nearest first, never the start', async () => {
    const r = await nearestRoutes(3, [6, 1, 3, 5, 4], 3);
    expect(r.map((x) => x.jumps)).toEqual([1, 2, 2]);
    expect(r[0].id).toBe(4);
    expect(r.some((x) => x.id === 3)).toBe(false);
    expect(r.some((x) => x.id === 6)).toBe(false);
  });

  it('works the same in secure mode, and skips unknown systems', async () => {
    const r = await nearestRoutes(1, [99, 6, 2], 5, 'secure');
    expect(r.map((x) => x.id)).toEqual([2, 6]);
    expect(r[1].jumps).toBe(5);
  });
});

describe('npcBuyers', () => {
  const order = (o: Partial<MarketOrder>): MarketOrder => ({
    duration: 365, is_buy_order: true, location_id: 60000001, system_id: 30000001, type_id: 30745, ...o,
  });
  it('keeps 365-day buy orders at NPC stations only', () => {
    const b = npcBuyers([
      order({}),
      order({ type_id: 30747 }),
      order({ duration: 90, location_id: 60000002 }),            // a player's
      order({ is_buy_order: false, location_id: 60000003 }),     // a sell order
      order({ location_id: 1035466617946 }),                     // a player structure
    ], new Set([60000001, 60000002, 60000003]));
    expect([...b.keys()]).toEqual([60000001]);
    expect([...b.get(60000001)!.types].sort()).toEqual([30745, 30747]);
  });
});
