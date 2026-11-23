import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

function makeApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session =
      { userId, characterId: 900, role: 'full', userCorpId: null, userAllianceId: null };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

describe.skipIf(!dbReady)('chain numbers (integration)', () => {
  let me: number;
  let app: express.Express;
  let mapId: string;
  let n = 0;

  const system = async (isHome = false): Promise<string> => {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class, is_home) VALUES ($1, $2, $3, $4, 'C3', $5)`,
      [id, mapId, 31000200 + ++n, `J${n}`, isHome]);
    return id;
  };
  const link = (a: string, b: string) => db.query(
    `INSERT INTO map_connections (id, map_id, source_id, target_id) VALUES ($1, $2, $3, $4)`,
    [crypto.randomUUID(), mapId, a, b]);
  const jump = (from: string, to: string) =>
    request(app).post(`/api/maps/${mapId}/systems/${to}/chain-number`).send({ fromSystemId: from });

  beforeEach(async () => {
    await truncateAll();
    me = await seedUser({ characterId: 900, role: 'full' });
    app = makeApp(me);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name, chain_numbering) VALUES ($1, 'M', TRUE) RETURNING id`, [me]);
    mapId = rows[0].id;
  });

  it('numbers holes in the order they are first jumped, and never twice', async () => {
    const home = await system(true);
    const a = await system(), b = await system(), c = await system();
    for (const s of [a, b, c]) await link(home, s);
    const aa = await system(); await link(a, aa);

    expect((await jump(home, a)).body.chainLabel).toBe('1');
    expect((await jump(home, b)).body.chainLabel).toBe('2');
    expect((await jump(a, aa)).body.chainLabel).toBe('11');
    // Jumping back and forth changes nothing; the way home gets no number.
    expect((await jump(home, a)).body.chainLabel).toBe('1');
    expect((await jump(a, home)).body.chainLabel).toBeNull();

    // 2 is gone: the next hole out of home is 3, not 2 again.
    await db.query(`DELETE FROM map_systems WHERE id = $1`, [b]);
    expect((await jump(home, c)).body.chainLabel).toBe('3');
  });

  it('does nothing when the map does not number chains, or the systems are not linked', async () => {
    const home = await system(true);
    const a = await system(), b = await system();
    await link(home, a);
    expect((await jump(home, b)).status).toBe(400);
    await db.query(`UPDATE maps SET chain_numbering = FALSE WHERE id = $1`, [mapId]);
    expect((await jump(home, a)).body.chainLabel).toBeNull();
  });

  it('can be set by hand, and only to a well-formed number', async () => {
    const a = await system();
    expect((await request(app).patch(`/api/maps/${mapId}/systems/${a}`).send({ chainLabel: '5.10' })).status).toBe(200);
    expect((await request(app).patch(`/api/maps/${mapId}/systems/${a}`).send({ chainLabel: '=cmd' })).status).toBe(400);
    const { rows } = await db.query<{ l: string }>(`SELECT chain_label AS l FROM map_systems WHERE id = $1`, [a]);
    expect(rows[0].l).toBe('5.10');
  });
});
