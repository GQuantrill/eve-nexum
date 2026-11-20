import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

vi.mock('../services/entityNames.js', () => ({
  resolveEntityNames: vi.fn(async () => new Map()),
}));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';
import { restoreSystem } from '../services/mapTrash.js';

const dbReady = await ensureIntegrationDb();

// Reported: deleting the wrong system and pressing undo brought the box and its
// lines back, but every signature was gone. Undo now restores what the server
// kept of the delete.

function appFor(userId: number, characterId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId, characterName: `Pilot ${characterId}`, role: 'full',
      userCorpId: null, userAllianceId: null, ownerId: null,
    };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

async function addSystem(mapId: string, eveId: number | null, name: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class, notes) VALUES ($1, $2, $3, $4, 'C3', 'home notes')`,
    [id, mapId, eveId, name],
  );
  return id;
}

const count = async (sql: string, params: unknown[]) =>
  Number((await db.query<{ n: string }>(sql, params)).rows[0].n);

describe.skipIf(!dbReady)('undo a delete (integration: real SQL)', () => {
  let userId: number;
  let app: express.Express;
  let mapId: string;
  let a: string;
  let b: string;
  let conn: string;
  let sig: string;

  beforeEach(async () => {
    await truncateAll();
    userId = await seedUser({ characterId: 9001, role: 'full' });
    app = appFor(userId, 9001);
    mapId = (await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name) VALUES ($1, 'Map') RETURNING id`, [userId])).rows[0].id;
    a = await addSystem(mapId, null, 'J111111');
    b = await addSystem(mapId, null, 'J222222');
    sig = (await db.query<{ id: string }>(
      `INSERT INTO map_signatures (system_id, sig_id, sig_type, notes) VALUES ($1, 'ABC-123', 'wormhole', 'to b') RETURNING id`, [a])).rows[0].id;
    await db.query(`INSERT INTO map_signatures (system_id, sig_id, sig_type) VALUES ($1, 'DEF-456', 'data')`, [a]);
    await db.query(`INSERT INTO map_anomalies (system_id, anom_id, name) VALUES ($1, 'GHI-789', 'Sansha')`, [a]);
    await db.query(`INSERT INTO map_structures (system_id, name) VALUES ($1, 'Astrahus')`, [a]);
    conn = randomUUID();
    await db.query(
      `INSERT INTO map_connections (id, map_id, source_id, target_id, source_signature_id) VALUES ($1, $2, $3, $4, $5)`,
      [conn, mapId, a, b, sig]);
    await db.query(
      `INSERT INTO map_connection_jumps (connection_id, map_id, character_name) VALUES ($1, $2, 'Someone')`, [conn, mapId]);
  });

  it('brings back the signatures, anomalies, structures, connection and jump log', async () => {
    await request(app).delete(`/api/maps/${mapId}/systems/${a}`).expect(200);
    expect(await count(`SELECT COUNT(*) n FROM map_signatures WHERE system_id = $1`, [a])).toBe(0);

    const res = await request(app).post(`/api/maps/${mapId}/systems/${a}/restore`).expect(200);
    expect(res.body.systemId).toBe(a);
    expect(res.body.system.notes).toBe('home notes');
    expect(res.body.connections.map((c: { id: string }) => c.id)).toEqual([conn]);

    expect(await count(`SELECT COUNT(*) n FROM map_signatures WHERE system_id = $1`, [a])).toBe(2);
    expect(await count(`SELECT COUNT(*) n FROM map_anomalies WHERE system_id = $1`, [a])).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM map_structures WHERE system_id = $1`, [a])).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM map_connection_jumps WHERE connection_id = $1`, [conn])).toBe(1);
    const { rows } = await db.query(`SELECT source_signature_id FROM map_connections WHERE id = $1`, [conn]);
    expect(rows[0].source_signature_id).toBe(sig);
  });

  it('restores once, and only for the pilot who deleted it', async () => {
    await request(app).delete(`/api/maps/${mapId}/systems/${a}`).expect(200);
    const other = await seedUser({ characterId: 9002, role: 'full' });
    expect(await restoreSystem(mapId, a, other)).toBeNull();
    await request(app).post(`/api/maps/${mapId}/systems/${a}/restore`).expect(200);
    await request(app).post(`/api/maps/${mapId}/systems/${a}/restore`).expect(404);
  });

  it('says so once the copy has expired', async () => {
    await request(app).delete(`/api/maps/${mapId}/systems/${a}`).expect(200);
    await db.query(`UPDATE map_trash SET deleted_at = NOW() - interval '2 hours'`);
    await request(app).post(`/api/maps/${mapId}/systems/${a}/restore`).expect(404);
  });

  it('restores into the same system when it was re-added meanwhile', async () => {
    await db.query(`UPDATE map_systems SET eve_system_id = 31000001 WHERE id = $1`, [a]);
    await request(app).delete(`/api/maps/${mapId}/systems/${a}`).expect(200);
    const again = await addSystem(mapId, 31000001, 'J111111');
    // A signature scanned again since: kept, not duplicated.
    await db.query(`INSERT INTO map_signatures (system_id, sig_id, sig_type) VALUES ($1, 'ABC-123', 'wormhole')`, [again]);

    const res = await request(app).post(`/api/maps/${mapId}/systems/${a}/restore`).expect(200);
    expect(res.body.systemId).toBe(again);
    expect(await count(`SELECT COUNT(*) n FROM map_systems WHERE map_id = $1`, [mapId])).toBe(2);
    expect(await count(`SELECT COUNT(*) n FROM map_signatures WHERE system_id = $1`, [again])).toBe(2);
    // The connection comes back on the re-added system, its sig link dropped
    // because that signature was the duplicate that didn't come back.
    const { rows } = await db.query(`SELECT source_id, source_signature_id FROM map_connections WHERE id = $1`, [conn]);
    expect(rows[0].source_id).toBe(again);
    expect(rows[0].source_signature_id).toBeNull();
  });

  it('brings back a deleted connection with its jump log', async () => {
    await request(app).delete(`/api/maps/${mapId}/connections/${conn}`).expect(200);
    expect(await count(`SELECT COUNT(*) n FROM map_connection_jumps WHERE connection_id = $1`, [conn])).toBe(0);
    const res = await request(app).post(`/api/maps/${mapId}/connections/${conn}/restore`).expect(200);
    expect(res.body.connections).toHaveLength(1);
    expect(await count(`SELECT COUNT(*) n FROM map_connection_jumps WHERE connection_id = $1`, [conn])).toBe(1);
  });

  it('does not duplicate a connection drawn again meanwhile', async () => {
    await request(app).delete(`/api/maps/${mapId}/connections/${conn}`).expect(200);
    await db.query(`INSERT INTO map_connections (id, map_id, source_id, target_id) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), mapId, b, a]);
    const res = await request(app).post(`/api/maps/${mapId}/connections/${conn}/restore`).expect(200);
    expect(res.body.connections).toHaveLength(0);
    expect(await count(`SELECT COUNT(*) n FROM map_connections WHERE map_id = $1`, [mapId])).toBe(1);
  });
});
