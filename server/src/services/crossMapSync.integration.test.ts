import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { syncTargets } from './crossMapSync.js';

const dbReady = await ensureIntegrationDb();

const J123 = 31000123;
const CORP = 98000001, OTHER_CORP = 98000002;
const ALLY = 99000001, OTHER_ALLY = 99000002;

// Cross-map sync must never move intel across scopes: personal <-> personal of
// one account, corp <-> corp of one corp, alliance <-> alliance of one
// alliance. The scoping is entirely in SQL, so it runs against a real database.

async function newOwner(): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`INSERT INTO owners DEFAULT VALUES RETURNING id`);
  return rows[0].id;
}

async function userOn(characterId: number, ownerId: number, syncOn: boolean): Promise<number> {
  const id = await seedUser({ characterId, role: 'admin' });
  await db.query(
    `UPDATE users SET owner_id = $1, ui_settings = $2::jsonb WHERE id = $3`,
    [ownerId, JSON.stringify({ 'nexum.crossMapSync': syncOn }), id],
  );
  return id;
}

interface MapOpts { userId: number; ownerId: number; corpId?: number; allianceId?: number; sync?: boolean }

// A map holding J123; returns [mapId, systemId].
async function mapWithJ123(o: MapOpts): Promise<[string, string]> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, owner_id, name, corp_id, alliance_id, cross_map_sync)
     VALUES ($1, $2, 'm', $3, $4, $5) RETURNING id`,
    [o.userId, o.ownerId, o.corpId ?? null, o.allianceId ?? null, o.sync ?? false],
  );
  const sysId = randomUUID();
  await db.query(
    `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class) VALUES ($1, $2, $3, 'J123', 'C3')`,
    [sysId, rows[0].id, J123],
  );
  return [rows[0].id, sysId];
}

const mapIds = (t: { mapId: string }[]) => t.map((x) => x.mapId).sort();

describe.skipIf(!dbReady)('cross-map sync scoping (integration)', () => {
  let owner: number, main: number, alt: number;

  beforeEach(async () => {
    await truncateAll();
    owner = await newOwner();
    main = await userOn(101, owner, true);
    alt  = await userOn(102, owner, true);
  });

  it('syncs an alliance map only with that alliance\'s other opted-in maps', async () => {
    const [src, srcSys]  = await mapWithJ123({ userId: main, ownerId: owner, allianceId: ALLY, sync: true });
    const [allyOn]       = await mapWithJ123({ userId: alt,  ownerId: owner, allianceId: ALLY, sync: true });
    await mapWithJ123({ userId: main, ownerId: owner, allianceId: ALLY, sync: false });      // opted out
    await mapWithJ123({ userId: main, ownerId: owner, allianceId: OTHER_ALLY, sync: true }); // other alliance
    await mapWithJ123({ userId: main, ownerId: owner, corpId: CORP, sync: true });           // corp map
    await mapWithJ123({ userId: main, ownerId: owner });                                     // creator's personal map

    expect(mapIds(await syncTargets(src, srcSys, main))).toEqual([allyOn]);
  });

  it('does nothing from an alliance map that is not opted in', async () => {
    const [src, srcSys] = await mapWithJ123({ userId: main, ownerId: owner, allianceId: ALLY, sync: false });
    const [allyOn]      = await mapWithJ123({ userId: main, ownerId: owner, allianceId: ALLY, sync: true });
    // Control: the opted-in sibling would receive it from an opted-in source.
    const [src2, src2Sys] = await mapWithJ123({ userId: main, ownerId: owner, allianceId: ALLY, sync: true });
    expect(mapIds(await syncTargets(src2, src2Sys, main))).toEqual([allyOn]);

    expect(await syncTargets(src, srcSys, main)).toEqual([]);
  });

  it('syncs a corp map only with that corp\'s other opted-in corp maps', async () => {
    const [src, srcSys] = await mapWithJ123({ userId: main, ownerId: owner, corpId: CORP, sync: true });
    const [corpOn]      = await mapWithJ123({ userId: main, ownerId: owner, corpId: CORP, sync: true });
    await mapWithJ123({ userId: main, ownerId: owner, corpId: OTHER_CORP, sync: true });
    await mapWithJ123({ userId: main, ownerId: owner, allianceId: ALLY, sync: true });
    await mapWithJ123({ userId: main, ownerId: owner });

    expect(mapIds(await syncTargets(src, srcSys, main))).toEqual([corpOn]);
  });

  it('syncs a personal map with every personal map on the account, alts included, and nothing else', async () => {
    const [src, srcSys] = await mapWithJ123({ userId: main, ownerId: owner });
    const [altMap]      = await mapWithJ123({ userId: alt,  ownerId: owner });
    await mapWithJ123({ userId: main, ownerId: owner, allianceId: ALLY, sync: true });
    await mapWithJ123({ userId: main, ownerId: owner, corpId: CORP, sync: true });
    const stranger = await newOwner();
    const other = await userOn(303, stranger, true);
    await mapWithJ123({ userId: other, ownerId: stranger });

    expect(mapIds(await syncTargets(src, srcSys, main))).toEqual([altMap]);
  });

  it('only syncs a personal map when the editing account has sync on', async () => {
    const off = await newOwner();
    const offUser = await userOn(404, off, false);
    const [src, srcSys] = await mapWithJ123({ userId: offUser, ownerId: off });
    await mapWithJ123({ userId: offUser, ownerId: off });
    expect(await syncTargets(src, srcSys, offUser)).toEqual([]);
  });

  it('never lets someone a personal map is shared with push into the owner\'s other maps', async () => {
    const [src, srcSys] = await mapWithJ123({ userId: main, ownerId: owner });
    const [altMap]      = await mapWithJ123({ userId: alt,  ownerId: owner });
    const guest = await userOn(505, await newOwner(), true);

    // Control: the owner's own edit does reach the alt's map.
    expect(mapIds(await syncTargets(src, srcSys, main))).toEqual([altMap]);
    expect(await syncTargets(src, srcSys, guest)).toEqual([]);
  });
});
