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
import { mapsRouter } from './maps.js';
import { presenceSnapshot } from '../services/presence.js';

const dbReady = await ensureIntegrationDb();
const CORP = 1000;

// corpId is a parameter, not a constant: hard-coding it made an "outsider"
// present as a corp member, so the access assertion below tested nothing.
function appFor(userId: number, characterId: number, characterName: string, corpId: number | null = CORP) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId, characterName, role: 'readonly',
      userCorpId: corpId, userAllianceId: null, ownerId: null,
    };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

describe.skipIf(!dbReady)('presence hide (integration)', () => {
  let mapId: string;
  let aliceId: number;
  let bobId: number;

  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, allianceMode: false, corpIds: [CORP], restrictedMode: true, adminCharId: null };
    aliceId = await seedUser({ characterId: 11, corpId: CORP, role: 'readonly' });
    bobId   = await seedUser({ characterId: 22, corpId: CORP, role: 'readonly' });
    mapId = (await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name, corp_id) VALUES ($1, 'Corp Map', $2) RETURNING id`, [aliceId, CORP],
    )).rows[0].id;
  });

  it('shows a viewer once they report, and removes them when they hide', async () => {
    await request(appFor(aliceId, 11, 'Alice'))
      .post(`/api/maps/${mapId}/presence`).send({ eveSystemId: 30000142 }).expect(204);
    expect(presenceSnapshot(mapId).map((p) => p.characterId)).toContain(11);

    await request(appFor(aliceId, 11, 'Alice')).delete(`/api/maps/${mapId}/presence`).expect(200);
    expect(presenceSnapshot(mapId).map((p) => p.characterId)).not.toContain(11);
  });

  it('removes only the caller, never anyone else', async () => {
    await request(appFor(aliceId, 11, 'Alice')).post(`/api/maps/${mapId}/presence`).send({ eveSystemId: 30000142 });
    await request(appFor(bobId, 22, 'Bob')).post(`/api/maps/${mapId}/presence`).send({ eveSystemId: 30000142 });
    expect(presenceSnapshot(mapId)).toHaveLength(2);

    await request(appFor(aliceId, 11, 'Alice')).delete(`/api/maps/${mapId}/presence`).expect(200);
    const left = presenceSnapshot(mapId).map((p) => p.characterId);
    expect(left).toEqual([22]);
  });

  it('404s for a map the caller cannot see', async () => {
    const outsiderId = await seedUser({ characterId: 33, corpId: 9999, role: 'readonly' });
    await request(appFor(outsiderId, 33, 'Outsider', 9999))
      .delete(`/api/maps/${mapId}/presence`).expect(404);
  });
});
