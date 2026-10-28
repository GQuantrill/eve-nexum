import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/entityNames.js', () => ({ resolveEntityNames: vi.fn(async () => new Map()) }));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from '../routes/maps.js';

const dbReady = await ensureIntegrationDb();

interface U { id: number; characterId: number }

function makeApp(u: U | null) {
  const app = express();
  // Mirror index.ts: the app-wide parser leaves the import route to its own.
  const json = express.json({ limit: '2mb' });
  app.use((req, res, next) => (req.method === 'POST' && req.path === '/api/maps/import' ? next() : json(req, res, next)));
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = u
      ? { userId: u.id, characterId: u.characterId, role: 'full', userCorpId: null, userAllianceId: null, ownerId: null }
      : {};
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

const J1 = 31000005;
const J2 = 31000006;

describe.skipIf(!dbReady)('map backup (integration)', () => {
  let owner: U;
  let outsider: U;
  let mapId: string;

  beforeEach(async () => {
    await truncateAll();
    await db.query(`INSERT INTO solar_systems (id, name, class, effect, statics) VALUES
      ($1, 'J100001', 'C3', 'pulsar', '{D845}'), ($2, 'J100002', 'C5', NULL, '{H296,V911}')`, [J1, J2]);
    owner = { id: await seedUser({ characterId: 1, role: 'full' }), characterId: 1 };
    outsider = { id: await seedUser({ characterId: 2, role: 'full' }), characterId: 2 };

    mapId = (await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name, lazy_remove_wormholes, collapse_grace_hours, bookmark_format)
       VALUES ($1, 'Home', true, 2, '{sig} {type}') RETURNING id`, [owner.id])).rows[0].id;
    const s1 = (await db.query<{ id: string }>(
      `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class, position_x, position_y, notes, intel, labels, tag, alias, is_home)
       VALUES (gen_random_uuid(), $1, $2, 'J100001', 'C3', 0, 0, 'home notes', 'friendly', '{a}', 'H', 'Home', true) RETURNING id`, [mapId, J1])).rows[0].id;
    const s2 = (await db.query<{ id: string }>(
      `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class, position_x, position_y)
       VALUES (gen_random_uuid(), $1, $2, 'J100002', 'C5', 300, 0) RETURNING id`, [mapId, J2])).rows[0].id;
    // An unmapped hole's placeholder.
    const s3 = (await db.query<{ id: string }>(
      `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class, position_x, position_y)
       VALUES (gen_random_uuid(), $1, NULL, 'Unknown', 'unknown', 600, 0) RETURNING id`, [mapId])).rows[0].id;
    const sig = (await db.query<{ id: string }>(
      `INSERT INTO map_signatures (system_id, sig_id, sig_type, wh_type, wh_leads_to, notes, created_at, created_by_user_id)
       VALUES ($1, 'ABC-123', 'wormhole', 'H296', 'C5', 'outbound', NOW() - interval '5 hours', $2) RETURNING id`,
      [s1, owner.id])).rows[0].id;
    await db.query(
      `INSERT INTO map_signatures (system_id, sig_id, sig_type, name, created_by_user_id)
       VALUES ($1, 'DEF-456', 'relic', 'Forgotten Frontier Quarantine Outpost', $2)`, [s2, owner.id]);
    await db.query(
      `INSERT INTO map_connections (id, map_id, source_id, target_id, wh_type, mass_status, time_status, size, mass_used,
                                    eol_at, flag_icon, flag_note, flag_color, source_signature_id)
       VALUES (gen_random_uuid(), $1, $2, $3, 'H296', 'destabilized', 'eol', 'xl', 1500000000, NOW() - interval '1 hour',
               'Skull', 'bubbled', '#ff8800', $4)`, [mapId, s1, s2, sig]);
    await db.query(`INSERT INTO map_connections (id, map_id, source_id, target_id, connection_type) VALUES (gen_random_uuid(), $1, $2, $3, 'standard')`, [mapId, s2, s3]);
    await db.query(`INSERT INTO map_anomalies (system_id, anom_id, anom_type, name) VALUES ($1, 'XYZ-987', 'combat', 'Sleeper Data Sanctuary')`, [s1]);
    await db.query(`INSERT INTO map_structures (system_id, name, structure_type, owner_corp) VALUES ($1, 'Fort', 'Astrahus', 'Us')`, [s1]);
    await db.query(`INSERT INTO map_routes (map_id, name, system_ids, connection_ids) VALUES ($1, 'Saved', '{}', '{}')`, [mapId]);
    await db.query(`UPDATE maps SET share_token = gen_random_uuid() WHERE id = $1`, [mapId]);
  });

  it('exports the whole chain, and nothing about who can see it', async () => {
    const res = await request(makeApp(owner)).get(`/api/maps/${mapId}/export`);
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b).toMatchObject({ format: 'nexum-map', version: 2, name: 'Home',
      settings: { lazyRemoveWormholes: true, collapseGraceHours: 2, bookmarkFormat: '{sig} {type}' } });
    expect(b.systems).toHaveLength(3);
    expect(b.connections).toHaveLength(2);
    expect(b.signatures).toHaveLength(2);
    expect(b.anomalies).toHaveLength(1);
    expect(b.structures).toHaveLength(1);
    const hole = b.connections.find((c: { type: string | null }) => c.type === 'H296');
    expect(hole).toMatchObject({ massStatus: 'destabilized', timeStatus: 'eol', massUsed: 1500000000, flagNote: 'bubbled' });
    expect(hole.eolAt).toBeTruthy();
    expect(hole.sourceSignatureId).toBe(b.signatures.find((g: { sigId: string }) => g.sigId === 'ABC-123').id);
    const text = JSON.stringify(b);
    expect(text).not.toContain('share');
    expect(text).not.toContain('Saved');
  });

  it("won't export a map you can't open", async () => {
    expect((await request(makeApp(outsider)).get(`/api/maps/${mapId}/export`)).status).toBe(404);
    expect((await request(makeApp(null)).get(`/api/maps/${mapId}/export`)).status).toBe(401);
  });

  it('round-trips: importing an export rebuilds the chain as a new map owned by the importer', async () => {
    const backup = (await request(makeApp(owner)).get(`/api/maps/${mapId}/export`)).body;
    const imp = await request(makeApp(outsider)).post('/api/maps/import').send(backup);
    expect(imp.status).toBe(201);
    expect(imp.body.imported).toEqual({ systems: 3, connections: 2, signatures: 2, anomalies: 1, structures: 1 });
    const newId = imp.body.id as string;
    expect(newId).not.toBe(mapId);

    const { rows: [m] } = await db.query(
      `SELECT user_id, lazy_remove_wormholes, collapse_grace_hours, bookmark_format, share_token FROM maps WHERE id = $1`, [newId]);
    expect(m).toMatchObject({ user_id: outsider.id, lazy_remove_wormholes: true, collapse_grace_hours: 2, bookmark_format: '{sig} {type}', share_token: null });

    const { rows: systems } = await db.query(
      `SELECT eve_system_id, name, system_class, effect, statics, notes, intel, labels, tag, alias, is_home
         FROM map_systems WHERE map_id = $1 ORDER BY position_x`, [newId]);
    expect(systems[0]).toMatchObject({ eve_system_id: J1, system_class: 'C3', effect: 'pulsar', statics: ['D845'],
      notes: 'home notes', intel: 'friendly', labels: ['a'], tag: 'H', alias: 'Home', is_home: true });
    expect(systems[2]).toMatchObject({ eve_system_id: null, system_class: 'unknown' });

    // The hole keeps its clocks and flag, and is still linked to its signature.
    const { rows: [hole] } = await db.query(
      `SELECT c.mass_status, c.time_status, c.size, c.mass_used, c.eol_at, c.flag_note, c.flag_color, g.sig_id, g.created_at
         FROM map_connections c JOIN map_signatures g ON g.id = c.source_signature_id
        WHERE c.map_id = $1`, [newId]);
    expect(hole).toMatchObject({ mass_status: 'destabilized', time_status: 'eol', size: 'xl', mass_used: '1500000000',
      flag_note: 'bubbled', flag_color: '#ff8800', sig_id: 'ABC-123' });
    expect(hole.eol_at).toBeTruthy();
    // The signature keeps its age -- its lifetime runs from when it was scanned.
    expect(Date.now() - new Date(hole.created_at).getTime()).toBeGreaterThan(4.9 * 3_600_000);

    expect((await db.query(`SELECT 1 FROM map_routes WHERE map_id = $1`, [newId])).rowCount).toBe(0);
  });

  it("takes a system's class, effect and statics from the SDE, not the file", async () => {
    const backup = (await request(makeApp(owner)).get(`/api/maps/${mapId}/export`)).body;
    backup.systems[0].systemClass = 'HS';
    backup.systems[0].statics = ['ZZZ'];
    backup.systems[0].name = 'Jita';
    const imp = await request(makeApp(owner)).post('/api/maps/import').send(backup);
    const { rows: [s] } = await db.query(
      `SELECT name, system_class, statics FROM map_systems WHERE map_id = $1 AND eve_system_id = $2`, [imp.body.id, J1]);
    expect(s).toEqual({ name: 'J100001', system_class: 'C3', statics: ['D845'] });
  });

  it('still imports an old-style export (the raw map state)', async () => {
    const imp = await request(makeApp(owner)).post('/api/maps/import').send({
      name: 'Legacy',
      systems: [
        { id: 'a', eveSystemId: J1, name: 'J100001', position: { x: 0, y: 0 } },
        { id: 'b', eveSystemId: null, name: 'J100002', position: { x: 100, y: 0 } }, // by name
      ],
      connections: [{ id: 'x', sourceId: 'a', targetId: 'b', type: 'H296', massStatus: 'critical' }],
    });
    expect(imp.status).toBe(201);
    expect(imp.body.imported).toMatchObject({ systems: 2, connections: 1, signatures: 0 });
  });

  it('refuses a file that is not a map', async () => {
    expect((await request(makeApp(owner)).post('/api/maps/import').send({ hello: 'world' })).status).toBe(400);
  });

  it('takes a backup bigger than the app-wide 2 MB body limit', async () => {
    const backup = (await request(makeApp(owner)).get(`/api/maps/${mapId}/export`)).body;
    backup.signatures = Array.from({ length: 12_000 }, (_, i) => ({
      id: `big${i}`, systemId: backup.systems[1].id, sigId: '', sigType: 'unknown', notes: 'x'.repeat(150),
    }));
    expect(JSON.stringify(backup).length).toBeGreaterThan(2 * 1024 * 1024);
    const imp = await request(makeApp(owner)).post('/api/maps/import').send(backup);
    expect(imp.status).toBe(201);
    expect(imp.body.imported.signatures).toBe(12_000);
  });
});
