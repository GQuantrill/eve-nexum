import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

function makeApp(userId: number, role = 'full') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session =
      { userId, characterId: 900, role, userCorpId: null, userAllianceId: null };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

const A = 31000101, B = 31000102, C = 31000103;

async function seedMap(userId: number, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, name]);
  return rows[0].id;
}
async function seedSystem(mapId: string, eve: number, name: string, x: number, y: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class, position_x, position_y)
     VALUES ($1, $2, $3, $4, 'C3', $5, $6)`, [id, mapId, eve, name, x, y]);
  return id;
}
async function link(mapId: string, a: string, b: string): Promise<void> {
  await db.query(
    `INSERT INTO map_connections (id, map_id, source_id, target_id) VALUES ($1, $2, $3, $4)`,
    [crypto.randomUUID(), mapId, a, b]);
}

describe.skipIf(!dbReady)('copy and paste systems (integration)', () => {
  let me: number;
  let app: express.Express;

  beforeEach(async () => {
    await truncateAll();
    await db.query(`INSERT INTO solar_systems (id, name, class) VALUES ($1, 'J100001', 'C3'), ($2, 'J100002', 'C3'), ($3, 'J100003', 'C3')`, [A, B, C]);
    me = await seedUser({ characterId: 900, role: 'full' });
    app = makeApp(me);
  });

  it('copies only the selected systems, the links between them and their sigs', async () => {
    const src = await seedMap(me, 'Source');
    const a = await seedSystem(src, A, 'J100001', 0, 0);
    const b = await seedSystem(src, B, 'J100002', 300, 0);
    const c = await seedSystem(src, C, 'J100003', 600, 0);
    await link(src, a, b);
    await link(src, b, c);
    await db.query(`INSERT INTO map_signatures (system_id, sig_id, sig_type) VALUES ($1, 'ABC-123', 'wormhole'), ($2, 'XYZ-999', 'data')`, [b, c]);

    const res = await request(app).post(`/api/maps/${src}/clip`).send({ systemIds: [a, b] });
    expect(res.status).toBe(200);
    expect(res.body.format).toBe('nexum-systems');
    expect(res.body.systems.map((s: { name: string }) => s.name).sort()).toEqual(['J100001', 'J100002']);
    expect(res.body.connections).toHaveLength(1);
    expect(res.body.signatures.map((g: { sigId: string }) => g.sigId)).toEqual(['ABC-123']);
  });

  it('pastes into another map: lines up on a system it already has, adds only what is missing', async () => {
    const src = await seedMap(me, 'Source');
    const a = await seedSystem(src, A, 'J100001', 0, 0);
    const b = await seedSystem(src, B, 'J100002', 300, 0);
    await link(src, a, b);
    await db.query(`INSERT INTO map_signatures (system_id, sig_id, sig_type, notes) VALUES ($1, 'ABC-123', 'wormhole', 'from source'), ($1, 'NEW-001', 'gas', '')`, [a]);
    const clip = (await request(app).post(`/api/maps/${src}/clip`).send({ systemIds: [a, b] })).body;

    const dest = await seedMap(me, 'Dest');
    const da = await seedSystem(dest, A, 'J100001', 1000, 500);
    await db.query(`INSERT INTO map_signatures (system_id, sig_id, sig_type, notes) VALUES ($1, 'ABC-123', 'wormhole', 'mine')`, [da]);

    const res = await request(app).post(`/api/maps/${dest}/paste`).send({ clip, anchor: { x: -5000, y: -5000 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ systems: 1, connections: 1, signatures: 1, matched: 1 });

    // The new system sits where it did relative to A, not at the anchor.
    const nb = await db.query<{ x: number; y: number }>(
      `SELECT position_x AS x, position_y AS y FROM map_systems WHERE map_id = $1 AND eve_system_id = $2`, [dest, B]);
    expect(nb.rows[0]).toEqual({ x: 1300, y: 500 });
    // The map's own sig is untouched.
    const sig = await db.query<{ notes: string }>(`SELECT notes FROM map_signatures WHERE system_id = $1 AND sig_id = 'ABC-123'`, [da]);
    expect(sig.rows[0].notes).toBe('mine');

    // Pasting again adds nothing.
    const again = await request(app).post(`/api/maps/${dest}/paste`).send({ clip });
    expect(again.body).toMatchObject({ systems: 0, connections: 0, signatures: 0, matched: 2 });
  });

  it('with nothing in common, centres the group on where it was pasted', async () => {
    const src = await seedMap(me, 'Source');
    const b = await seedSystem(src, B, 'J100002', 0, 0);
    const c = await seedSystem(src, C, 'J100003', 400, 200);
    await link(src, b, c);
    const clip = (await request(app).post(`/api/maps/${src}/clip`).send({ systemIds: [b, c] })).body;

    const dest = await seedMap(me, 'Dest');
    const res = await request(app).post(`/api/maps/${dest}/paste`).send({ clip, anchor: { x: 1000, y: 1000 } });
    expect(res.status).toBe(200);
    const rows = await db.query<{ x: number; y: number }>(
      `SELECT position_x AS x, position_y AS y FROM map_systems WHERE map_id = $1 ORDER BY eve_system_id`, [dest]);
    expect(rows.rows).toEqual([{ x: 800, y: 900 }, { x: 1200, y: 1100 }]);
  });

  it('refuses a paste into a map the caller can only read, and junk', async () => {
    const other = await seedUser({ characterId: 901 });
    const theirs = await seedMap(other, 'Theirs');
    const mine = await seedMap(me, 'Mine');
    const clip = { systems: [{ id: crypto.randomUUID(), eveSystemId: A, name: 'J100001' }], connections: [] };
    expect((await request(app).post(`/api/maps/${theirs}/paste`).send({ clip })).status).toBe(404);
    expect((await request(app).post(`/api/maps/${mine}/paste`).send({ clip: 'nope' })).status).toBe(400);
    expect((await request(app).post(`/api/maps/${theirs}/clip`).send({ systemIds: [crypto.randomUUID()] })).status).toBe(404);
  });

  it('an import can save chains and label systems the map already has', async () => {
    const dest = await seedMap(me, 'Dest');
    const da = await seedSystem(dest, A, 'J100001', 0, 0);
    await db.query(`UPDATE map_systems SET custom_labels = ARRAY['t:Home'] WHERE id = $1`, [da]);
    await db.query(`INSERT INTO map_routes (map_id, name) VALUES ($1, 'Taken')`, [dest]);
    const clip = {
      name: 'import',
      systems: [
        { id: 'sa', eveSystemId: A, name: 'J100001', customLabels: ['t:Alpha', 't:home'] },
        { id: 'sb', eveSystemId: B, name: 'J100002', customLabels: ['t:Alpha'] },
        { id: 'sc', eveSystemId: C, name: 'J100003' },
      ],
      connections: [{ sourceId: 'sa', targetId: 'sb' }, { sourceId: 'sb', targetId: 'sc' }],
    };
    const res = await request(app).post(`/api/maps/${dest}/paste`).send({
      clip, mergeLabels: true,
      chains: [
        { name: 'Alpha', systemIds: ['sa', 'sb', 'sc'] },
        { name: 'taken', systemIds: ['sa', 'sb'] },     // name in use
        { name: 'Gap', systemIds: ['sa', 'sc'] },       // no link between them
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ systems: 2, connections: 2, labels: 1, chains: 1 });
    const lab = await db.query<{ l: string[] }>(`SELECT custom_labels AS l FROM map_systems WHERE id = $1`, [da]);
    expect(lab.rows[0].l).toEqual(['t:Home', 't:Alpha']);
    const nb = await db.query<{ l: string[] }>(`SELECT custom_labels AS l FROM map_systems WHERE map_id = $1 AND eve_system_id = $2`, [dest, B]);
    expect(nb.rows[0].l).toEqual(['t:Alpha']);
    const r = await db.query<{ name: string; n: number; c: number }>(
      `SELECT name, cardinality(system_ids) AS n, cardinality(connection_ids) AS c FROM map_routes WHERE map_id = $1 ORDER BY name`, [dest]);
    expect(r.rows).toEqual([{ name: 'Alpha', n: 3, c: 2 }, { name: 'Taken', n: 0, c: 0 }]);
  });

  it('a copy says which saved chain each system is in', async () => {
    const src = await seedMap(me, 'Source');
    const a = await seedSystem(src, A, 'J100001', 0, 0);
    const b = await seedSystem(src, B, 'J100002', 300, 0);
    await db.query(`INSERT INTO map_routes (map_id, name, system_ids) VALUES ($1, 'Static', $2)`, [src, [a, b]]);
    const res = await request(app).post(`/api/maps/${src}/clip`).send({ systemIds: [a] });
    expect(res.body.chains).toEqual([{ name: 'Static', systemIds: [a] }]);
  });
});
