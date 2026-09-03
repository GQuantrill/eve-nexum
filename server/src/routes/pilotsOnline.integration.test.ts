import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { characterRouter } from './character.js';

const dbReady = await ensureIntegrationDb();
const CORP = 1000, OTHER_CORP = 2000, ALLY = 5000;

function appFor(userId: number, corpId: number | null, allianceId: number | null = null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: 1, characterName: 'Me', role: 'full',
      userCorpId: corpId, userAllianceId: allianceId, ownerId: null,
    };
    next();
  });
  app.use('/api/character', characterRouter);
  return app;
}

// minutesAgo(null) leaves last_seen_at NULL — never seen.
async function seen(userId: number, minutesAgo: number | null, extra: Record<string, unknown> = {}) {
  await db.query(
    `UPDATE users SET last_seen_at = CASE WHEN $2::int IS NULL THEN NULL
                                          ELSE NOW() - ($2 || ' minutes')::interval END,
                      ship_type_name = $3, ship_name = $4, ui_settings = COALESCE($5::jsonb, ui_settings)
      WHERE id = $1`,
    [userId, minutesAgo, extra.ship ?? null, extra.shipName ?? null, extra.settings ?? null],
  );
}

describe.skipIf(!dbReady)('pilots-online (integration)', () => {
  let me: number;

  beforeEach(async () => {
    await truncateAll();
    // The harness creates the SDE tables empty; seed the one system these
    // assertions read back.
    await db.query(`INSERT INTO map_regions (id, name) VALUES (10000002, 'The Forge')`);
    await db.query(`INSERT INTO solar_systems (id, name, class, region_id) VALUES (30000142, 'Jita', 'HS', 10000002)`);

    state.over = { corpMode: true, allianceMode: false, corpIds: [CORP], restrictedMode: true };
    me = await seedUser({ characterId: 1, corpId: CORP, role: 'full' });
  });

  it('lists a corp mate seen recently, with their ship', async () => {
    const mate = await seedUser({ characterId: 2, corpId: CORP, role: 'full' });
    await seen(mate, 2, { ship: 'Stiletto', shipName: 'Scout One' });
    await db.query(`UPDATE users SET last_known_system_id = 30000142 WHERE id = $1`, [mate]);
    const res = await request(appFor(me, CORP)).get('/api/character/pilots-online').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].characterName).toBeTruthy();
    expect(res.body[0].shipTypeName).toBe('Stiletto');
    expect(res.body[0].shipName).toBe('Scout One');
    expect(res.body[0].systemName).toBe('Jita');
    expect(res.body[0].regionName).toBe('The Forge');
  });

  it('excludes anyone not seen inside the window', async () => {
    const stale = await seedUser({ characterId: 3, corpId: CORP, role: 'full' });
    await seen(stale, 30);
    const never = await seedUser({ characterId: 4, corpId: CORP, role: 'full' });
    await seen(never, null);
    const res = await request(appFor(me, CORP)).get('/api/character/pilots-online').expect(200);
    expect(res.body).toHaveLength(0);
  });

  it('excludes other corps', async () => {
    const outsider = await seedUser({ characterId: 5, corpId: OTHER_CORP, role: 'full' });
    await seen(outsider, 1);
    const res = await request(appFor(me, CORP)).get('/api/character/pilots-online').expect(200);
    expect(res.body).toHaveLength(0);
  });

  it('excludes the caller themselves', async () => {
    await seen(me, 1);
    const res = await request(appFor(me, CORP)).get('/api/character/pilots-online').expect(200);
    expect(res.body).toHaveLength(0);
  });

  it('excludes a pilot who has hidden their presence', async () => {
    const shy = await seedUser({ characterId: 6, corpId: CORP, role: 'full' });
    await seen(shy, 1, { settings: JSON.stringify({ 'nexum.presence.hidden': true }) });
    const res = await request(appFor(me, CORP)).get('/api/character/pilots-online').expect(200);
    expect(res.body).toHaveLength(0);
  });

  it('excludes blocked users', async () => {
    const blocked = await seedUser({ characterId: 7, corpId: CORP, role: 'full' });
    await seen(blocked, 1);
    await db.query(`UPDATE users SET blocked = TRUE WHERE id = $1`, [blocked]);
    const res = await request(appFor(me, CORP)).get('/api/character/pilots-online').expect(200);
    expect(res.body).toHaveLength(0);
  });

  it('scopes to the alliance on an alliance install', async () => {
    state.over = { corpMode: false, allianceMode: true, allianceIds: [ALLY], restrictedMode: true };
    const otherCorpSameAlliance = await seedUser({ characterId: 8, corpId: OTHER_CORP, allianceId: ALLY, role: 'full' });
    await seen(otherCorpSameAlliance, 1);
    const res = await request(appFor(me, CORP, ALLY)).get('/api/character/pilots-online').expect(200);
    expect(res.body).toHaveLength(1);
  });

  it('returns empty on a solo install with no corp or alliance', async () => {
    const res = await request(appFor(me, null, null)).get('/api/character/pilots-online').expect(200);
    expect(res.body).toEqual([]);
  });
});
