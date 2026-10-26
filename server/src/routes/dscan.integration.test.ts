import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Corp install, so a readonly member really is readonly.
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

// ESI stand-in for the local lookup: /universe/ids/ knows two pilots,
// /characters/affiliation/ puts them in one corp, /universe/names/ names it.
const esi = vi.hoisted(() => ({ down: false }));
vi.mock('../utils/esi.js', () => ({
  esiFetch: vi.fn(async (url: string, init: RequestInit) => {
    if (esi.down) return new Response('', { status: 503 });
    const body = JSON.parse(String(init.body)) as unknown[];
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.endsWith('/universe/ids/')) {
      const known: Record<string, number> = { 'bob pilot': 90000001, alice: 90000002 };
      return json({
        characters: (body as string[]).filter((n) => known[n.toLowerCase()])
          .map((n) => ({ id: known[n.toLowerCase()], name: n.toLowerCase() === 'alice' ? 'Alice' : 'Bob Pilot' })),
      });
    }
    if (url.endsWith('/characters/affiliation/')) {
      return json((body as number[]).map((id) => ({ character_id: id, corporation_id: 98000001, alliance_id: 99000001 })));
    }
    if (url.endsWith('/universe/names/')) {
      return json((body as number[]).map((id) => ({ id, name: id === 98000001 ? 'Some Corp' : 'Some Alliance', category: 'corporation' })));
    }
    return new Response('', { status: 404 });
  }),
}));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { dscanRouter } from './dscan.js';

const dbReady = await ensureIntegrationDb();

const CORP = 1000;
const JITA = 30000142;

interface U { id: number; characterId: number; role: string; corpId: number }

function makeApp(u: U | null) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = u
      ? { userId: u.id, characterId: u.characterId, role: u.role, userCorpId: u.corpId, userAllianceId: null, ownerId: null }
      : {};
    next();
  });
  app.use('/api/dscan', dscanRouter);
  return app;
}

const SCAN = [
  "29984\tBob's Tengu\tTengu\t1,234 km",
  "29984\tAlice's Tengu\tTengu\t2,000 km",
  '11567\tAvatar\tAvatar\t4.2 AU',
  '35832\tHome\tAstrahus\t-',
  '99999999\tMystery\tBrand New Ship\t5 km',
].join('\n');

describe.skipIf(!dbReady)('d-scan analyser (integration)', () => {
  let member: U;
  let readonly: U;
  let outsider: U;
  let mapId: string;
  let sysId: string;

  beforeEach(async () => {
    await truncateAll();
    esi.down = false;
    state.over = { corpMode: true, allianceMode: false, corpIds: [CORP], restrictedMode: true, adminCharId: null };

    await db.query(`INSERT INTO item_categories (id, name) VALUES (2, 'Celestial'), (6, 'Ship'), (65, 'Structure')`);
    await db.query(`INSERT INTO item_groups (id, name, category_id) VALUES
      (6, 'Sun', 2), (963, 'Strategic Cruiser', 6), (30, 'Titan', 6), (1657, 'Citadel', 65)`);
    await db.query(`INSERT INTO item_types (id, name, group_id, mass) VALUES
      (45041, 'Sun G5 (Yellow)', 6, NULL),
      (29984, 'Tengu', 963, 8200000), (11567, 'Avatar', 30, 2278125000), (35832, 'Astrahus', 1657, 1000000)`);
    await db.query(`INSERT INTO solar_systems (id, name, class) VALUES ($1, 'Jita', 'HS'), (30002187, 'Amarr', 'HS')`, [JITA]);

    const ownerId = await seedUser({ characterId: 1, corpId: CORP, role: 'full' });
    member   = { id: await seedUser({ characterId: 2, corpId: CORP, role: 'full' }), characterId: 2, role: 'full', corpId: CORP };
    readonly = { id: await seedUser({ characterId: 3, corpId: CORP, role: 'readonly' }), characterId: 3, role: 'readonly', corpId: CORP };
    outsider = { id: await seedUser({ characterId: 4, corpId: 2000, role: 'full' }), characterId: 4, role: 'full', corpId: 2000 };

    mapId = (await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name, corp_id) VALUES ($1, 'Corp Map', $2) RETURNING id`, [ownerId, CORP],
    )).rows[0].id;
    sysId = (await db.query<{ id: string }>(
      `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class)
       VALUES (gen_random_uuid(), $1, $2, 'Jita', 'HS') RETURNING id`, [mapId, JITA],
    )).rows[0].id;
  });

  it('lets anyone create a d-scan and anyone view it by link', async () => {
    const created = await request(makeApp(null)).post('/api/dscan').send({ text: SCAN });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('dscan');

    const view = await request(makeApp(null)).get(`/api/dscan/${created.body.id}`);
    expect(view.status).toBe(200);
    const { data } = view.body;
    expect(data.rows).toHaveLength(5);
    expect(data.types['29984']).toEqual({ n: 'Tengu', g: 'Strategic Cruiser', s: 'ship', m: 8200000 });
    expect(data.types['35832'].s).toBe('structure');
    // Not in the SDE: kept under the name the paste gave it.
    expect(data.types['99999999']).toEqual({ n: 'Brand New Ship', g: '', s: 'other', m: null });
    expect(data.rows[3][2]).toBeNull();
  });

  it('resolves a local list into pilots and their corp and alliance', async () => {
    const created = await request(makeApp(null)).post('/api/dscan').send({ text: 'bob pilot\nAlice\nNot A Real Pilot' });
    expect(created.status).toBe(201);
    const { data } = (await request(makeApp(null)).get(`/api/dscan/${created.body.id}`)).body;
    expect(data.kind).toBe('local');
    expect(data.pilots).toEqual([
      { n: 'Bob Pilot', id: 90000001, c: 98000001, a: 99000001 },
      { n: 'Alice', id: 90000002, c: 98000001, a: 99000001 },
    ]);
    expect(data.unknown).toEqual(['Not A Real Pilot']);
    expect(data.names).toEqual({ 98000001: 'Some Corp', 99000001: 'Some Alliance' });
  });

  it('says so, and saves nothing, when ESI is down for a local list', async () => {
    esi.down = true;
    const res = await request(makeApp(null)).post('/api/dscan').send({ text: 'Bob Pilot' });
    expect(res.status).toBe(502);
    expect((await db.query('SELECT 1 FROM dscans')).rowCount).toBe(0);
  });

  it('refuses a paste it cannot read', async () => {
    const res = await request(makeApp(null)).post('/api/dscan').send({ text: '<b>hello</b>' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unrecognised');
    expect((await request(makeApp(null)).post('/api/dscan').send({ text: 42 })).status).toBe(400);
  });

  it('stops serving a scan once it expires', async () => {
    const created = await request(makeApp(null)).post('/api/dscan').send({ text: SCAN });
    await db.query(`UPDATE dscans SET expires_at = NOW() - INTERVAL '1 second'`);
    expect((await request(makeApp(null)).get(`/api/dscan/${created.body.id}`)).status).toBe(410);
  });

  it('404s an unknown or malformed id', async () => {
    expect((await request(makeApp(null)).get('/api/dscan/AAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await request(makeApp(null)).get("/api/dscan/x' OR 1=1")).status).toBe(404);
  });

  it('names the system from a Sun on the scan', async () => {
    const created = await request(makeApp(null)).post('/api/dscan')
      .send({ text: `${SCAN}\n45041\tAmarr - Star\tSun G5 (Yellow)\t12 AU` });
    expect(created.status).toBe(201);
    const view = await request(makeApp(null)).get(`/api/dscan/${created.body.id}`);
    expect(view.body.data.system).toEqual({ id: 30002187, name: 'Amarr', from: 'sun' });
  });

  it('leaves the system off when nothing names it', async () => {
    const created = await request(makeApp(null)).post('/api/dscan').send({ text: SCAN });
    const view = await request(makeApp(null)).get(`/api/dscan/${created.body.id}`);
    expect(view.body.data.system).toBeUndefined();
  });

  it('names a pinned scan after its map system, but lets a Sun win', async () => {
    const pinned = await request(makeApp(member)).post('/api/dscan').send({ text: SCAN, mapId, systemId: sysId });
    expect((await request(makeApp(null)).get(`/api/dscan/${pinned.body.id}`)).body.data.system)
      .toEqual({ id: JITA, name: 'Jita', from: 'map' });

    const local = await request(makeApp(member)).post('/api/dscan').send({ text: 'Bob Pilot', mapId, systemId: sysId });
    expect((await request(makeApp(null)).get(`/api/dscan/${local.body.id}`)).body.data.system)
      .toEqual({ id: JITA, name: 'Jita', from: 'map' });

    const withSun = await request(makeApp(member)).post('/api/dscan')
      .send({ text: `${SCAN}\n45041\tAmarr - Star\tSun G5 (Yellow)\t12 AU`, mapId, systemId: sysId });
    expect((await request(makeApp(null)).get(`/api/dscan/${withSun.body.id}`)).body.data.system)
      .toEqual({ id: 30002187, name: 'Amarr', from: 'sun' });
  });

  it('pins a scan to a map system for a member who can write the map', async () => {
    const created = await request(makeApp(member)).post('/api/dscan').send({ text: SCAN, mapId, systemId: sysId });
    expect(created.status).toBe(201);
    const list = await request(makeApp(member)).get(`/api/dscan/map/${mapId}/system/${JITA}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: created.body.id, summary: { kind: 'dscan', total: 5, ships: 3 } });
    // The pinned scan is still an ordinary public link.
    expect((await request(makeApp(null)).get(`/api/dscan/${created.body.id}`)).status).toBe(200);
  });

  it('lets a readonly member list but not pin', async () => {
    const pin = await request(makeApp(readonly)).post('/api/dscan').send({ text: SCAN, mapId, systemId: sysId });
    expect(pin.status).toBe(403);
    expect((await db.query('SELECT 1 FROM dscans')).rowCount).toBe(0);
    expect((await request(makeApp(readonly)).get(`/api/dscan/map/${mapId}/system/${JITA}`)).status).toBe(200);
  });

  it('keeps someone without map access from pinning or listing', async () => {
    expect((await request(makeApp(outsider)).post('/api/dscan').send({ text: SCAN, mapId, systemId: sysId })).status).toBe(404);
    expect((await request(makeApp(outsider)).get(`/api/dscan/map/${mapId}/system/${JITA}`)).status).toBe(404);
  });

  it('needs a login to pin or list', async () => {
    expect((await request(makeApp(null)).post('/api/dscan').send({ text: SCAN, mapId, systemId: sysId })).status).toBe(401);
    expect((await request(makeApp(null)).get(`/api/dscan/map/${mapId}/system/${JITA}`)).status).toBe(401);
  });

  it('refuses a system from a different map', async () => {
    const otherMap = (await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name) VALUES ($1, 'Mine') RETURNING id`, [member.id])).rows[0].id;
    const res = await request(makeApp(member)).post('/api/dscan').send({ text: SCAN, mapId: otherMap, systemId: sysId });
    expect(res.status).toBe(404);
  });

  it('drops expired scans from the system list', async () => {
    await request(makeApp(member)).post('/api/dscan').send({ text: SCAN, mapId, systemId: sysId });
    await db.query(`UPDATE dscans SET expires_at = NOW() - INTERVAL '1 second'`);
    expect((await request(makeApp(member)).get(`/api/dscan/map/${mapId}/system/${JITA}`)).body).toEqual([]);
  });
});
