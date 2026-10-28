import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('./entityNames.js', () => ({
  resolveEntityNames: vi.fn(async (ids: Array<number | null | undefined>) =>
    new Map(ids.filter((x): x is number => !!x).map((id) => [id, { name: `name-${id}` }]))),
}));

// current-kills reads CCP's hourly counts from ESI; keep the network out of it.
vi.mock('../utils/esi.js', () => ({ esiFetch: vi.fn(async () => new Response('', { status: 503 })) }));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { storeKill, flushKills, pruneKills, killsInSystems, clearPendingKills, KILL_STORE_DAYS, type StoredKill } from './killStore.js';
import { mapsRouter } from '../routes/maps.js';
import activityRouter from '../routes/activity.js';

const dbReady = await ensureIntegrationDb();

const HOUR = 3_600_000;
const JITA = 30000142;
const J1 = 31000005;
const ELSEWHERE = 30002187;

let nextId = 7_000_000_000;
function kill(over: Partial<StoredKill> = {}): StoredKill {
  return {
    killmailId: nextId++, atMs: Date.now() - 10 * 60_000, eveSystemId: JITA, shipTypeId: 670, totalValue: 10_000,
    victimCharacterId: 1, victimCorporationId: 2, victimAllianceId: 3,
    finalBlowCharacterId: 4, finalBlowCorporationId: 5, finalBlowAllianceId: 6, finalBlowShipTypeId: 11995,
    attackerCount: 3, solo: false, npc: false, tags: ['gate', 'hic'],
    ...over,
  };
}

describe.skipIf(!dbReady)('kill store (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    clearPendingKills();
  });

  it('stores kills once, and lists a set of systems newest first with a total', async () => {
    const a = kill({ atMs: Date.now() - 2 * HOUR });
    const b = kill({ eveSystemId: J1, atMs: Date.now() - HOUR });
    storeKill(a);
    storeKill(b);
    storeKill(a); // a replay of the same killmail
    storeKill(kill({ eveSystemId: ELSEWHERE }));
    await flushKills();
    expect((await db.query('SELECT 1 FROM recent_kills')).rowCount).toBe(3);

    const { kills, total } = await killsInSystems([JITA, J1], Date.now() - 24 * HOUR, 10);
    expect(kills.map((k) => k.killmailId)).toEqual([b.killmailId, a.killmailId]);
    expect(total).toBe(2);
    expect(kills[1]).toMatchObject({ tags: ['gate', 'hic'], attackerCount: 3, victimAllianceId: 3 });

    // The window cuts the older one.
    expect((await killsInSystems([JITA, J1], Date.now() - 90 * 60_000, 10)).kills.map((k) => k.killmailId)).toEqual([b.killmailId]);
  });

  it('includes kills that have not been flushed yet', async () => {
    const k = kill();
    storeKill(k);
    const { kills, total } = await killsInSystems([JITA], Date.now() - HOUR, 10);
    expect(kills.map((x) => x.killmailId)).toEqual([k.killmailId]);
    expect(total).toBe(1);
  });

  it('prunes kills older than a week', async () => {
    storeKill(kill({ atMs: Date.now() - (KILL_STORE_DAYS + 1) * 24 * HOUR }));
    storeKill(kill());
    await flushKills();
    expect(await pruneKills()).toBe(1);
    expect((await db.query('SELECT 1 FROM recent_kills')).rowCount).toBe(1);
  });

  it("serves a map's kills across all its systems, with system names, to someone who can open it", async () => {
    await db.query(`INSERT INTO solar_systems (id, name, class) VALUES ($1, 'Jita', 'HS'), ($2, 'J100001', 'C3')`, [JITA, J1]);
    const owner = await seedUser({ characterId: 1, role: 'full' });
    const outsider = await seedUser({ characterId: 2, role: 'full' });
    const mapId = (await db.query<{ id: string }>(`INSERT INTO maps (user_id, name) VALUES ($1, 'M') RETURNING id`, [owner])).rows[0].id;
    await db.query(
      `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class, position_x, position_y) VALUES
         (gen_random_uuid(), $1, $2, 'Jita', 'HS', 0, 0), (gen_random_uuid(), $1, $3, 'J100001', 'C3', 1, 0)`,
      [mapId, JITA, J1]);
    storeKill(kill({ eveSystemId: JITA, atMs: Date.now() - 2 * HOUR }));
    storeKill(kill({ eveSystemId: J1, atMs: Date.now() - 30 * 60_000 }));
    storeKill(kill({ eveSystemId: ELSEWHERE }));        // not on the map
    storeKill(kill({ eveSystemId: JITA, atMs: Date.now() - 3 * 24 * HOUR }));
    await flushKills();

    const app = (userId: number) => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        (req as express.Request & { session: object }).session = { userId, characterId: userId, role: 'full', userCorpId: null, userAllianceId: null, ownerId: null };
        next();
      });
      a.use('/api/maps', mapsRouter);
      return a;
    };
    const day = await request(app(owner)).get(`/api/maps/${mapId}/kills?window=24h`);
    expect(day.status).toBe(200);
    expect(day.body.total).toBe(2);
    expect(day.body.kills.map((k: { systemName: string }) => k.systemName)).toEqual(['J100001', 'Jita']);
    expect(day.body.kills[0]).toMatchObject({ tags: ['gate', 'hic'], eveSystemId: J1 });
    expect(day.body.kills[0].victim.character_name).toBe('name-1');

    expect((await request(app(owner)).get(`/api/maps/${mapId}/kills?window=1h`)).body.total).toBe(1);
    expect((await request(app(owner)).get(`/api/maps/${mapId}/kills?window=7d`)).body.total).toBe(3);
    expect((await request(app(outsider)).get(`/api/maps/${mapId}/kills`)).status).toBe(404);
  });

  it('puts a 24h player-kill count on each system in current-kills', async () => {
    // Our own feed's count for a wormhole system, CCP's for k-space; the
    // higher of the two wins where both have one.
    await db.query(
      `INSERT INTO system_pvp_hours (eve_system_id, hour, kills) VALUES
         ($1, date_trunc('hour', NOW()) - interval '2 hours', 4),
         ($1, date_trunc('hour', NOW()) - interval '30 hours', 50),
         ($2, date_trunc('hour', NOW()) - interval '1 hour', 3)`, [J1, JITA]);
    await db.query(
      `INSERT INTO system_activity (eve_system_id, hour, ship_kills, pod_kills) VALUES
         ($1, date_trunc('hour', NOW()) - interval '3 hours', 6, 2)`, [JITA]);
    const a = express();
    a.use((req, _res, next) => { (req as express.Request & { session: object }).session = { userId: 1 }; next(); });
    a.use('/api/activity', activityRouter);
    const res = await request(a).get('/api/activity/current-kills');
    expect(res.status).toBe(200);
    const by = new Map((res.body as Array<{ systemId: number; kills24h: number }>).map((r) => [r.systemId, r.kills24h]));
    expect(by.get(J1)).toBe(4);   // the 30-hour-old row is outside the day
    expect(by.get(JITA)).toBe(8); // CCP's 6 + 2 beats our 3
  });
});
