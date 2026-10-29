import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/entityNames.js', () => ({
  resolveEntityNames: async (ids: Array<number | null | undefined>) =>
    new Map(ids.filter((x): x is number => !!x).map((id) => [id, { name: `name-${id}` }])),
}));
// The stored half of the kill list is Postgres. These tests are about merging
// the in-memory live buffer, so give them an empty store rather than whatever
// database .env happens to point at (no DB, or a wrong password, failed them
// locally while CI's empty test DB let them pass).
vi.mock('../services/killStore.js', () => ({
  killsInSystems: async () => ({ kills: [], total: 0 }),
}));

import { liveKillToEntry, withLiveKills, type KillEntry } from './killboard.js';
import { recordKill, type BufferedKill } from '../services/killBuffer.js';

const SYS = 30000142;

function buffered(id: number, over: Partial<BufferedKill> = {}): BufferedKill {
  return {
    killmailId: id, atMs: Date.now() - 60_000, eveSystemId: SYS, shipTypeId: 670, totalValue: 12_000,
    victimCharacterId: 1, victimCorporationId: 2, victimAllianceId: 3,
    finalBlowCharacterId: 4, finalBlowCorporationId: 5, finalBlowAllianceId: 6, finalBlowShipTypeId: 587,
    attackerCount: 4, solo: false, npc: false,
    ...over,
  };
}

function restEntry(id: number): KillEntry {
  return {
    killmail_id: id, killmail_time: new Date(Date.now() - 3_600_000).toISOString(),
    victim: { ship_type_id: 587 }, attackers: [{ final_blow: true }],
    zkb: { hash: 'h', totalValue: 1, solo: false, npc: false },
  };
}

describe('liveKillToEntry', () => {
  it('renders a buffered kill with names, the final blow and the attacker count', () => {
    const names = new Map([[1, { name: 'Victim' }], [3, { name: 'Victim Alliance' }], [4, { name: 'Shooter' }]]);
    const e = liveKillToEntry(buffered(10), names);
    expect(e.victim).toMatchObject({ character_name: 'Victim', alliance_id: 3, alliance_name: 'Victim Alliance' });
    expect(e.attackers).toHaveLength(4);
    expect(e.attackers.filter((a) => a.final_blow)).toEqual([expect.objectContaining({ character_name: 'Shooter', ship_type_id: 587 })]);
    expect(e.zkb).toEqual({ hash: '', totalValue: 12_000, solo: false, npc: false });
  });
});

describe('withLiveKills', () => {
  it("adds live kills zKill's cached list hasn't caught up with, newest first, without duplicates", async () => {
    recordKill(buffered(500));          // already in the REST list
    recordKill(buffered(600));          // newer than anything zKill returned
    recordKill(buffered(700, { eveSystemId: 31000009 })); // another system
    const out = await withLiveKills(SYS, [restEntry(500), restEntry(400)], 86_400);
    expect(out.map((k) => k.killmail_id)).toEqual([600, 500, 400]);
    expect(out[0].victim.character_name).toBe('name-1');
  });

  it('leaves out live kills older than the window', async () => {
    recordKill(buffered(800, { atMs: Date.now() - 3 * 3_600_000, eveSystemId: 31000010 }));
    expect(await withLiveKills(31000010, [], 3_600)).toEqual([]);
  });
});
