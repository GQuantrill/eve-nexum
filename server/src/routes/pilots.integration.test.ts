import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Corp install, so a readonly member really is readonly. Same ESI stand-in as
// the d-scan test: two known pilots in one corp and alliance.
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
import { pilotsRouter } from './pilots.js';
import { sweepOldSightings } from '../services/pilotSightings.js';

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
  app.use('/api/pilots', pilotsRouter);
  return app;
}

describe.skipIf(!dbReady)('pilot sightings (integration)', () => {
  let member: U;
  let readonly: U;
  let outsider: U;
  let mapId: string;
  let sysId: string;

  beforeEach(async () => {
    await truncateAll();
    esi.down = false;
    state.over = { corpMode: true, allianceMode: false, corpIds: [CORP], restrictedMode: true, adminCharId: null };
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

  const sightings = (u: U, query = '') =>
    request(makeApp(u)).get(`/api/pilots/sightings?ids=90000001,90000002,90000003${query}`);

  it('records every pilot of a local list pinned to a system', async () => {
    const pin = await request(makeApp(member)).post('/api/dscan').send({ text: 'Bob Pilot\nAlice', mapId, systemId: sysId });
    expect(pin.status).toBe(201);
    const res = await sightings(readonly);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ eveSystemId: JITA, systemName: 'Jita', mapId, source: 'local', corpId: 98000001 });
  });

  it('counts the same paste again within minutes once', async () => {
    for (let i = 0; i < 2; i++) {
      await request(makeApp(member)).post('/api/dscan').send({ text: 'Bob Pilot', mapId, systemId: sysId });
    }
    expect((await sightings(member)).body).toHaveLength(1);
  });

  it('records nothing for an unpinned paste', async () => {
    await request(makeApp(member)).post('/api/dscan').send({ text: 'Bob Pilot' });
    expect((await sightings(member)).body).toHaveLength(0);
  });

  it('shows sightings only on maps the requester can see', async () => {
    await request(makeApp(member)).post('/api/dscan').send({ text: 'Bob Pilot', mapId, systemId: sysId });
    expect((await sightings(outsider)).body).toHaveLength(0);
    expect((await sightings(outsider, `&mapId=${mapId}`)).status).toBe(404);
    expect((await sightings(member, `&mapId=${mapId}`)).body).toHaveLength(1);
  });

  it('records a watched pilot from intel for a member who can write the map', async () => {
    const line = { mapId, eveSystemId: 30002187, pilots: [{ id: 90000002, name: 'Alice' }] };
    expect((await request(makeApp(readonly)).post('/api/pilots/sightings').send(line)).status).toBe(403);
    expect((await request(makeApp(outsider)).post('/api/pilots/sightings').send(line)).status).toBe(404);
    const ok = await request(makeApp(member)).post('/api/pilots/sightings').send(line);
    expect(ok.status).toBe(200);
    expect(ok.body.added).toBe(1);
    expect((await sightings(member)).body[0]).toMatchObject({ systemName: 'Amarr', source: 'intel', name: 'Alice' });
  });

  it('records intel at the time it was posted, once however often it is sent', async () => {
    const at = Date.now() - 3 * 3_600_000;
    const line = { mapId, eveSystemId: 30002187, pilots: [{ id: 90000003, name: 'Bob' }], seenAt: at };
    const first = await request(makeApp(member)).post('/api/pilots/sightings').send(line);
    expect(first.body.added).toBe(1);
    // Watching again looks back over the same feed: nothing new.
    expect((await request(makeApp(member)).post('/api/pilots/sightings').send(line)).body.added).toBe(0);
    const row = (await sightings(member)).body.find((r: { name: string }) => r.name === 'Bob');
    expect(Math.abs(new Date(row.seenAt).getTime() - at)).toBeLessThan(1000);
    // A sighting now, hours later, still counts.
    const now = await request(makeApp(member)).post('/api/pilots/sightings').send({ ...line, seenAt: undefined });
    expect(now.body.added).toBe(1);
  });

  it('refuses a posted time outside the 30 days kept or in the future', async () => {
    const base = { mapId, eveSystemId: JITA, pilots: [{ id: 90000003, name: 'Bob' }] };
    for (const seenAt of [Date.now() - 31 * 86_400_000, Date.now() + 3_600_000, 'yesterday']) {
      expect((await request(makeApp(member)).post('/api/pilots/sightings').send({ ...base, seenAt })).status).toBe(400);
    }
  });

  it('refuses a malformed intel sighting', async () => {
    const bad = [
      { mapId, eveSystemId: 'x', pilots: [{ id: 1, name: 'Alice' }] },
      { mapId, eveSystemId: JITA, pilots: [] },
      { mapId, eveSystemId: JITA, pilots: [{ id: 1, name: 'x' }] },
      { mapId: 'nope', eveSystemId: JITA, pilots: [{ id: 1, name: 'Alice' }] },
    ];
    for (const b of bad) expect((await request(makeApp(member)).post('/api/pilots/sightings').send(b)).status).toBe(400);
  });

  it('needs a login and some ids to read', async () => {
    expect((await request(makeApp(null)).get('/api/pilots/sightings?ids=1')).status).toBe(401);
    expect((await request(makeApp(member)).get('/api/pilots/sightings?ids=')).status).toBe(400);
  });

  it('sweeps sightings older than 30 days', async () => {
    await request(makeApp(member)).post('/api/dscan').send({ text: 'Bob Pilot', mapId, systemId: sysId });
    await db.query(`UPDATE pilot_sightings SET seen_at = NOW() - INTERVAL '31 days'`);
    expect(await sweepOldSightings()).toBe(1);
  });
});
