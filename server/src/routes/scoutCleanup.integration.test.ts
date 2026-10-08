import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// The cleanup reads the live feed itself. Stub it so a test can say exactly
// which holes are still listed.
const feed = vi.hoisted(() => ({ rows: [] as { id: string; outSystemName: string }[] }));
vi.mock('./scout.js', () => ({ getScoutConnections: async () => feed.rows }));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

function appFor(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: userId,
    };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

/** A signature as the copy button would have written it. */
async function seedScoutSig(systemId: string, scoutId: string, ageMinutes: number, over: Record<string, string> = {}) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO map_signatures (system_id, sig_id, sig_type, name, notes, wh_type, wh_leads_to,
                                 scout_connection_id, scout_last_seen)
     VALUES ($1, $2, 'wormhole', $3, $4, 'C729', 'Thera', $5, NOW() - ($6 || ' minutes')::interval)
     RETURNING id`,
    [systemId, over.sigId ?? 'ABC-123', over.name ?? '', over.notes ?? '', scoutId, ageMinutes],
  );
  return rows[0].id;
}

describe.skipIf(!dbReady)('scout cleanup (integration)', () => {
  let user: number, mapId: string, sysId: string;

  beforeEach(async () => {
    await truncateAll();
    feed.rows = [];
    user = await seedUser({ characterId: 1, name: 'Scout' });
    mapId = (await db.query<{ id: string }>(
      `INSERT INTO maps (name, user_id) VALUES ('m', $1) RETURNING id`, [user])).rows[0].id;
    sysId = (await db.query<{ id: string }>(
      `INSERT INTO map_systems (id, map_id, name, system_class, position_x, position_y)
       VALUES (gen_random_uuid(), $1, 'Isamm', 'LS', 0, 0) RETURNING id`, [mapId])).rows[0].id;
  });

  const sweep = () => request(appFor(user)).post(`/api/maps/${mapId}/scout-cleanup`).send({ hub: 'Thera' });
  const sigCount = async () =>
    Number((await db.query('SELECT count(*) FROM map_signatures WHERE system_id = $1', [sysId])).rows[0].count);

  it('removes a hole the feed dropped more than the grace period ago', async () => {
    await seedScoutSig(sysId, 'gone-1', 120);
    const r = await sweep();
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(1);
    expect(await sigCount()).toBe(0);
  });

  it('keeps a hole that only just left the feed', async () => {
    // The grace period is the whole point: eve-scout lists a hole until
    // somebody reports it gone, so one stale read must not delete a live chain.
    await seedScoutSig(sysId, 'recent-1', 5);
    expect((await sweep()).body.removed).toBe(0);
    expect(await sigCount()).toBe(1);
  });

  it('keeps a hole the feed still lists, however old the row', async () => {
    await seedScoutSig(sysId, 'live-1', 9999);
    feed.rows = [{ id: 'live-1', outSystemName: 'Thera' }];
    expect((await sweep()).body.removed).toBe(0);
    expect(await sigCount()).toBe(1);
  });

  it('never touches a signature a person created', async () => {
    // No provenance marker => not ours => structurally unreachable.
    await db.query(
      `INSERT INTO map_signatures (system_id, sig_id, sig_type, wh_leads_to)
       VALUES ($1, 'MAN-001', 'wormhole', 'Thera')`, [sysId]);
    expect((await sweep()).body.removed).toBe(0);
    expect(await sigCount()).toBe(1);
  });

  it('keeps one of ours that somebody has since annotated', async () => {
    await seedScoutSig(sysId, 'noted-1', 120, { notes: 'bubbled, do not use' });
    await seedScoutSig(sysId, 'named-1', 120, { name: 'my exit' });
    expect((await sweep()).body.removed).toBe(0);
    expect(await sigCount()).toBe(2);
  });

  it('severs the connection rather than deleting it', async () => {
    await seedScoutSig(sysId, 'gone-2', 120);
    const other = (await db.query<{ id: string }>(
      `INSERT INTO map_systems (id, map_id, name, system_class, position_x, position_y)
       VALUES (gen_random_uuid(), $1, 'Thera', 'Thera', 1, 1) RETURNING id`, [mapId])).rows[0].id;
    await db.query(
      `INSERT INTO map_connections (id, map_id, source_id, target_id, scout_connection_id)
       VALUES (gen_random_uuid(), $1, $2, $3, 'gone-2')`, [mapId, sysId, other]);

    const r = await sweep();
    expect(r.body.broken).toBe(1);
    const { rows } = await db.query<{ broken: boolean }>(
      'SELECT broken FROM map_connections WHERE map_id = $1', [mapId]);
    // Still there, so the chain stays traceable -- just quarantined.
    expect(rows).toHaveLength(1);
    expect(rows[0].broken).toBe(true);
  });

  it('refuses a hub it does not recognise', async () => {
    expect((await request(appFor(user)).post(`/api/maps/${mapId}/scout-cleanup`)
      .send({ hub: 'Jita' })).status).toBe(400);
  });
});
