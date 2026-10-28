import { describe, it, expect, beforeEach } from 'vitest';
import { useKillStore, type KillRow } from './killStore';

const row = (over: Partial<KillRow>): KillRow => ({
  killmailId: 1, atMs: Date.now(), eveSystemId: 30000142, systemName: 'Jita',
  regionName: 'The Forge', shipTypeId: 587, shipTypeName: 'Rifter', totalValue: 6e7,
  victimCharacterId: null, victimName: null, victimCorporationId: null, victimCorpName: null,
  npc: false, finalBlow: null, ...over,
});

describe('killStore.recordKill', () => {
  beforeEach(() => useKillStore.getState().reset());

  it('flags the node for a kill that just happened', () => {
    useKillStore.getState().recordKill(row({}));
    expect(useKillStore.getState().bySystem.has(30000142)).toBe(true);
  });

  it('logs but does not flag a killmail that arrives hours late', () => {
    useKillStore.getState().recordKill(row({ atMs: Date.now() - 5 * 3_600_000 }));
    const s = useKillStore.getState();
    expect(s.bySystem.has(30000142)).toBe(false);
    expect(s.log).toHaveLength(1);
  });
});

describe('killStore live marking', () => {
  beforeEach(() => useKillStore.getState().reset());

  it('marks live kills, not backfilled ones, and keeps the mark through a backfill', () => {
    useKillStore.getState().recordKill(row({ killmailId: 1 }));
    useKillStore.getState().seedBackfill([row({ killmailId: 1 }), row({ killmailId: 2, atMs: Date.now() - 60_000 })]);
    const byId = new Map(useKillStore.getState().log.map((k) => [k.killmailId, k]));
    expect(byId.get(1)?.live).toBe(true);
    expect(byId.get(2)?.live).toBeUndefined();
  });
});
