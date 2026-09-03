import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Restricted (corp) install, so deployment roles actually bind — in solo mode
// everyone is admin and there is nothing to test.
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

const CORP = 1000;
const HOME = 30000142;   // where the contributor is
const AWAY = 30002537;   // somewhere they are not

interface U { id: number; characterId: number; role: string }

function makeApp(u: U) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId: u.id, characterId: u.characterId, role: u.role,
      userCorpId: CORP, userAllianceId: null, ownerId: null,
    };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

describe.skipIf(!dbReady)('contributor role (integration)', () => {
  let contributor: U;
  let mapId: string;
  let homeSysId: string;
  let awaySysId: string;

  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, allianceMode: false, corpIds: [CORP], restrictedMode: true, adminCharId: null };

    // A corp map owned by someone else — the contributor reaches it as a corp
    // member, not as its owner (an owner edits their own map regardless).
    const ownerId = await seedUser({ characterId: 1, corpId: CORP, role: 'full' });
    contributor = { id: await seedUser({ characterId: 2, corpId: CORP, role: 'contributor' }), characterId: 2, role: 'contributor' };

    // The location poll records where a pilot is; that is what the server checks.
    await db.query(`UPDATE users SET last_known_system_id = $1 WHERE id = $2`, [HOME, contributor.id]);

    mapId = (await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name, corp_id) VALUES ($1, 'Corp Map', $2) RETURNING id`, [ownerId, CORP],
    )).rows[0].id;

    const mkSys = async (eveId: number, name: string) => (await db.query<{ id: string }>(
      `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class)
       VALUES (gen_random_uuid(), $1, $2, $3, 'HS') RETURNING id`, [mapId, eveId, name],
    )).rows[0].id;
    homeSysId = await mkSys(HOME, 'Jita');
    awaySysId = await mkSys(AWAY, 'Amamake');
  });

  // ── content: allowed ───────────────────────────────────────────────────────

  it('may add a signature', async () => {
    const res = await request(makeApp(contributor))
      .post(`/api/maps/${mapId}/systems/${awaySysId}/signatures`)
      .send({ sigId: 'ABC-123', sigType: 'wormhole' });
    expect(res.status).toBe(201);
  });

  it('may edit and delete a signature', async () => {
    const created = await request(makeApp(contributor))
      .post(`/api/maps/${mapId}/systems/${awaySysId}/signatures`).send({ sigId: 'DEF-456' });
    const sigId = created.body.id;
    const patch = await request(makeApp(contributor))
      .patch(`/api/maps/${mapId}/systems/${awaySysId}/signatures/${sigId}`).send({ name: 'renamed' });
    expect(patch.status).toBeLessThan(300);
    const del = await request(makeApp(contributor))
      .delete(`/api/maps/${mapId}/systems/${awaySysId}/signatures/${sigId}`);
    expect(del.status).toBeLessThan(300);
  });

  // ── topology: refused ──────────────────────────────────────────────────────

  it('may NOT add a system it is not sitting in (right-click / add adjacent)', async () => {
    const res = await request(makeApp(contributor))
      .post(`/api/maps/${mapId}/systems`)
      .send({ id: crypto.randomUUID(), eveSystemId: 30000144, name: 'Perimeter', systemClass: 'HS' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('topology_forbidden');
  });

  it('may NOT delete a system', async () => {
    const res = await request(makeApp(contributor)).delete(`/api/maps/${mapId}/systems/${awaySysId}`);
    expect(res.status).toBe(403);
  });

  it('may connect two systems when one end IS where it is', async () => {
    const res = await request(makeApp(contributor))
      .post(`/api/maps/${mapId}/connections`)
      .send({ id: crypto.randomUUID(), sourceId: awaySysId, targetId: homeSysId, sourceHandle: 'right', targetHandle: 'left' });
    // homeSysId is where they are, so the jump's link is allowed.
    expect(res.status).toBeLessThan(300);
  });

  it('may NOT move or rename a system', async () => {
    const res = await request(makeApp(contributor))
      .patch(`/api/maps/${mapId}/systems/${awaySysId}`)
      .send({ position: { x: 500, y: 500 } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('topology_forbidden');
  });

  it('may NOT edit or delete an existing connection', async () => {
    const connId = (await db.query<{ id: string }>(
      `INSERT INTO map_connections (id, map_id, source_id, target_id, connection_type)
       VALUES (gen_random_uuid(), $1, $2, $3, 'standard') RETURNING id`,
      [mapId, homeSysId, awaySysId],
    )).rows[0].id;

    const patch = await request(makeApp(contributor))
      .patch(`/api/maps/${mapId}/connections/${connId}`).send({ massStatus: 'critical' });
    expect(patch.status).toBe(403);

    const del = await request(makeApp(contributor)).delete(`/api/maps/${mapId}/connections/${connId}`);
    expect(del.status).toBe(403);
  });

  it('may NOT rename the map', async () => {
    const res = await request(makeApp(contributor)).patch(`/api/maps/${mapId}`).send({ name: 'mine now' });
    expect(res.status).toBe(403);
  });

  it('may NOT connect two systems when it is in neither', async () => {
    await db.query(`UPDATE users SET last_known_system_id = 30000999 WHERE id = $1`, [contributor.id]);
    const res = await request(makeApp(contributor))
      .post(`/api/maps/${mapId}/connections`)
      .send({ id: crypto.randomUUID(), sourceId: awaySysId, targetId: homeSysId, sourceHandle: 'right', targetHandle: 'left' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('topology_forbidden');
  });

  // ── movement: the one exception ────────────────────────────────────────────

  it('MAY add the system it is actually in (tracked jump)', async () => {
    await db.query(`UPDATE users SET last_known_system_id = 30000144 WHERE id = $1`, [contributor.id]);
    const res = await request(makeApp(contributor))
      .post(`/api/maps/${mapId}/systems`)
      .send({ id: crypto.randomUUID(), eveSystemId: 30000144, name: 'Perimeter', systemClass: 'HS' });
    expect(res.status).toBeLessThan(300);
  });

  it("MAY create the connection its own jump makes", async () => {
    const res = await request(makeApp(contributor))
      .post(`/api/maps/${mapId}/connections`)
      .send({ id: crypto.randomUUID(), sourceId: homeSysId, targetId: awaySysId, sourceHandle: 'right', targetHandle: 'left' });
    expect(res.status).toBeLessThan(300);
  });

  // ── the alt case ───────────────────────────────────────────────────────────

  it('accepts a tracked add from an alt on the same account', async () => {
    // owner_id is a FK to owners(id) — the multi-account grouping — not a
    // users.id. Both characters have to point at one real owner row, which is
    // exactly the shape resolveOwnerId reads.
    const ownerId = (await db.query<{ id: number }>(
      `INSERT INTO owners DEFAULT VALUES RETURNING id`)).rows[0].id;
    const altId = await seedUser({ characterId: 3, corpId: CORP, role: 'contributor' });
    // The ALT is in the system being added; the session character is elsewhere.
    await db.query(`UPDATE users SET owner_id = $1, last_known_system_id = 30000144 WHERE id = $2`, [ownerId, altId]);
    await db.query(`UPDATE users SET owner_id = $1, last_known_system_id = 30009999 WHERE id = $2`, [ownerId, contributor.id]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { session: Record<string, unknown> }).session = {
        userId: contributor.id, characterId: 2, role: 'contributor',
        userCorpId: CORP, userAllianceId: null, ownerId,
      };
      next();
    });
    app.use('/api/maps', mapsRouter);
    const res = await request(app)
      .post(`/api/maps/${mapId}/systems`)
      .send({ id: crypto.randomUUID(), eveSystemId: 30000144, name: 'Perimeter', systemClass: 'HS' });
    expect(res.status).toBeLessThan(300);
  });
});
