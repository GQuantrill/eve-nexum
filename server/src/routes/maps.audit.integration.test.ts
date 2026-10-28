import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});
vi.mock('../services/entityNames.js', () => ({
  resolveEntityNames: vi.fn(async () => new Map()),
}));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';
import { pruneMapAudit, writeMapAudit } from '../services/mapAudit.js';

const dbReady = await ensureIntegrationDb();

interface U { id: number; characterId: number; name: string; corpId: number | null; role: string }
async function mkUser(characterId: number, o: { corpId?: number | null; role?: string } = {}): Promise<U> {
  const name = `Pilot ${characterId}`;
  const role = o.role ?? 'full';
  const id = await seedUser({ characterId, corpId: o.corpId ?? null, role, name });
  return { id, characterId, name, corpId: o.corpId ?? null, role };
}

function appFor(u: U) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId: u.id, characterId: u.characterId, characterName: u.name, role: u.role,
      userCorpId: u.corpId, userAllianceId: null, ownerId: null,
    };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

const seedMap = async (userId: number, corpId: number | null = null): Promise<string> =>
  (await db.query<{ id: string }>(`INSERT INTO maps (user_id, name, corp_id) VALUES ($1, 'Map', $2) RETURNING id`, [userId, corpId])).rows[0].id;

// Audit writes are fire-and-forget; wait for them to land.
async function auditRows(mapId: string, count: number) {
  await vi.waitFor(async () => {
    const { rows } = await db.query(`SELECT 1 FROM map_audit WHERE map_id = $1`, [mapId]);
    expect(rows.length).toBe(count);
  }, { timeout: 2000 });
  const { rows } = await db.query<{ action: string; subject: string | null; details: Record<string, unknown> | null; character_name: string }>(
    `SELECT action, subject, details, character_name FROM map_audit WHERE map_id = $1 ORDER BY id`, [mapId]);
  return rows;
}

describe.skipIf(!dbReady)('map audit log (integration — real SQL)', () => {
  let owner: U;
  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, corpIds: [1000], allianceMode: false, corpMapShared: false };
    owner = await mkUser(900);
  });

  it('records system and connection changes with who made them, but not node drags', async () => {
    const mapId = await seedMap(owner.id);
    const app = appFor(owner);
    const a = randomUUID(), b = randomUUID(), c = randomUUID();
    await request(app).post(`/api/maps/${mapId}/systems`).send({ id: a, name: 'Alpha', systemClass: 'C2', position: { x: 0, y: 0 } }).expect(201);
    await request(app).post(`/api/maps/${mapId}/systems`).send({ id: b, name: 'Bravo', systemClass: 'C3', position: { x: 1, y: 1 } }).expect(201);
    await auditRows(mapId, 2);
    await request(app).patch(`/api/maps/${mapId}/systems/${a}`).send({ position: { x: 50, y: 50 } }).expect(200);
    await request(app).patch(`/api/maps/${mapId}/systems/${a}`).send({ alias: 'Home' }).expect(200);
    await request(app).post(`/api/maps/${mapId}/connections`).send({ id: c, sourceId: a, targetId: b }).expect(201);
    await auditRows(mapId, 4);
    await request(app).patch(`/api/maps/${mapId}/connections/${c}`).send({ massStatus: 'critical' }).expect(200);
    await auditRows(mapId, 5);
    await request(app).delete(`/api/maps/${mapId}/connections/${c}`).expect(200);
    await auditRows(mapId, 6);
    await request(app).delete(`/api/maps/${mapId}/systems/${b}`).expect(200);

    const rows = await auditRows(mapId, 7);
    expect(rows.map((r) => r.action)).toEqual([
      'system.add', 'system.add', 'system.update', 'connection.add', 'connection.update', 'connection.remove', 'system.remove',
    ]);
    expect(rows[2].subject).toBe('Home (Alpha)');
    expect(rows[2].details).toEqual({ fields: ['alias'] });
    expect(rows[3].subject).toBe('Home (Alpha) ↔ Bravo');
    expect(rows[4].details).toEqual({ fields: ['massStatus'], values: { massStatus: 'critical' } });
    expect(rows[6].subject).toBe('Bravo');
    expect(rows.every((r) => r.character_name === owner.name)).toBe(true);
  });

  it('folds rapid edits to the same signature into one entry', async () => {
    const mapId = await seedMap(owner.id);
    const app = appFor(owner);
    const sys = randomUUID();
    await request(app).post(`/api/maps/${mapId}/systems`).send({ id: sys, name: 'Alpha', systemClass: 'C2' }).expect(201);
    const sig = (await request(app).post(`/api/maps/${mapId}/systems/${sys}/signatures`).send({ sigId: 'ABC-123', sigType: 'wormhole' }).expect(201)).body as { id: string };
    await auditRows(mapId, 2);
    for (const name of ['N', 'No', 'Not']) {
      await request(app).patch(`/api/maps/${mapId}/systems/${sys}/signatures/${sig.id}`).send({ name }).expect(200);
      await auditRows(mapId, 3);
    }
    await request(app).patch(`/api/maps/${mapId}/systems/${sys}/signatures/${sig.id}`).send({ whType: 'H296' }).expect(200);
    await vi.waitFor(async () => {
      const { rows } = await db.query(`SELECT details FROM map_audit WHERE action = 'signature.update'`);
      expect(rows[0].details.values).toEqual({ whType: 'H296' });
    });
    const rows = await auditRows(mapId, 3);
    expect(rows[1]).toMatchObject({ action: 'signature.add', subject: 'ABC-123 in Alpha' });
    expect(rows[2].action).toBe('signature.update');
    expect((rows[2].details?.fields as string[]).sort()).toEqual(['name', 'whType']);
  });

  it('is readable by the owner and corp admins, not by other members', async () => {
    const member = await mkUser(901, { corpId: 1000 });
    const admin  = await mkUser(902, { corpId: 1000, role: 'admin' });
    const personal = await seedMap(owner.id);
    const corpMap  = await seedMap(member.id, 1000);
    await writeMapAudit({ userId: owner.id, characterId: 900, characterName: owner.name, viaApi: false }, personal, { action: 'system.add', subject: 'Alpha' });

    const res = await request(appFor(owner)).get(`/api/maps/${personal}/audit`).expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ action: 'system.add', subject: 'Alpha', characterName: owner.name, characterId: 900 });
    expect(res.body.retentionDays).toBe(30);

    await request(appFor(member)).get(`/api/maps/${corpMap}/audit`).expect(403);
    await request(appFor(admin)).get(`/api/maps/${corpMap}/audit`).expect(200);
  });

  it('pages and filters by kind', async () => {
    const mapId = await seedMap(owner.id);
    const who = { userId: owner.id, characterId: 900, characterName: owner.name, viaApi: false };
    for (let i = 0; i < 105; i++) await writeMapAudit(who, mapId, { action: i % 2 ? 'system.add' : 'connection.add', subject: String(i) });
    const app = appFor(owner);
    const first = (await request(app).get(`/api/maps/${mapId}/audit`).expect(200)).body;
    expect(first.entries).toHaveLength(100);
    expect(first.more).toBe(true);
    expect(first.entries[0].subject).toBe('104');
    const next = (await request(app).get(`/api/maps/${mapId}/audit?before=${first.entries[99].id}`).expect(200)).body;
    expect(next.entries.map((e: { subject: string }) => e.subject)).toEqual(['4', '3', '2', '1', '0']);
    expect(next.more).toBe(false);
    const systems = (await request(app).get(`/api/maps/${mapId}/audit?kind=system`).expect(200)).body;
    expect(systems.entries.every((e: { action: string }) => e.action === 'system.add')).toBe(true);
    expect(systems.entries).toHaveLength(52);
  });

  it('prunes entries older than 30 days', async () => {
    const mapId = await seedMap(owner.id);
    await db.query(
      `INSERT INTO map_audit (map_id, action, created_at) VALUES ($1, 'system.add', NOW() - INTERVAL '31 days'), ($1, 'system.add', NOW() - INTERVAL '29 days')`,
      [mapId],
    );
    expect(await pruneMapAudit()).toBe(1);
    const { rows } = await db.query(`SELECT 1 FROM map_audit WHERE map_id = $1`, [mapId]);
    expect(rows).toHaveLength(1);
  });
});
