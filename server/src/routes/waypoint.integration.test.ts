import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ESI is faked per character: who is online, and how the waypoint call answers.
const esi = vi.hoisted(() => ({
  online:   new Map<number, boolean>(),          // EVE character id → logged in
  waypoint: new Map<number, number>(),           // EVE character id → HTTP status (default 204)
  calls:    [] as { characterId: number; url: string }[],
}));
// Tokens are "tok-<users.id>", so the fake can tell whose call it is.
vi.mock('../utils/eveToken.js', () => ({
  getValidToken: vi.fn(async (userId: number) => `tok-${userId}`),
}));
const userToChar = vi.hoisted(() => new Map<number, number>());
vi.mock('../utils/esi.js', () => ({
  esiFetch: vi.fn(async (url: string, init: RequestInit = {}) => {
    const userId = Number(String((init.headers as Record<string, string>).Authorization).replace('Bearer tok-', ''));
    const characterId = userToChar.get(userId)!;
    if (url.includes('/online/')) {
      return new Response(JSON.stringify({ online: esi.online.get(characterId) ?? false }), { status: 200 });
    }
    if (url.includes('/location/')) {
      return new Response(JSON.stringify({ solar_system_id: 30000142 }), { status: 200 });
    }
    esi.calls.push({ characterId, url });
    return new Response(null, { status: esi.waypoint.get(characterId) ?? 204 });
  }),
}));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { characterRouter } from './character.js';

const dbReady = await ensureIntegrationDb();

function appFor(userId: number, ownerId: number | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: 1, characterName: 'Main', role: 'full', ownerId,
    };
    next();
  });
  app.use('/api/character', characterRouter);
  return app;
}

// Character ids are unique per test so the 5s location cache never carries an
// answer from one test into the next.
let nextChar = 9_000_000;
async function seedChar(name: string, ownerId: number | null, online: boolean) {
  const characterId = ++nextChar;
  const id = await seedUser({ characterId, name, role: 'full' });
  if (ownerId != null) await db.query(`UPDATE users SET owner_id = $1 WHERE id = $2`, [ownerId, id]);
  userToChar.set(id, characterId);
  esi.online.set(characterId, online);
  return { id, characterId };
}

describe.skipIf(!dbReady)('waypoint for several characters (integration)', () => {
  let owner: number;
  let main: { id: number; characterId: number };
  let scout: { id: number; characterId: number };
  let hauler: { id: number; characterId: number };
  let logi: { id: number; characterId: number };

  beforeEach(async () => {
    await truncateAll();
    esi.calls = [];
    esi.waypoint.clear();
    owner  = (await db.query<{ id: number }>(`INSERT INTO owners DEFAULT VALUES RETURNING id`)).rows[0].id;
    main   = await seedChar('Main',   owner, true);
    scout  = await seedChar('Scout',  owner, true);
    hauler = await seedChar('Hauler', owner, false);
    logi   = await seedChar('Logi',   owner, true);
  });

  it('sets it for every online character on the account and skips the offline one', async () => {
    const res = await request(appFor(main.id, owner)).post('/api/character/waypoint')
      .send({ destinationId: 30000142, clearOtherWaypoints: true, to: 'allOnline' }).expect(200);
    const byName = Object.fromEntries(res.body.results.map((r: { characterName: string; status: string }) => [r.characterName, r.status]));
    expect(byName).toEqual({ Main: 'ok', Scout: 'ok', Hauler: 'offline', Logi: 'ok' });
    expect(res.body.results[0].characterName).toBe('Main');   // the signed-in one first
    expect(esi.calls.map((c) => c.characterId).sort()).toEqual([main.characterId, scout.characterId, logi.characterId].sort());
    expect(esi.calls.every((c) => c.url.includes('clear_other_waypoints=true') && c.url.includes('destination_id=30000142'))).toBe(true);
  });

  it('reports a character that needs re-linking without failing the others', async () => {
    esi.waypoint.set(scout.characterId, 403);
    const res = await request(appFor(main.id, owner)).post('/api/character/waypoint')
      .send({ destinationId: 30000142, to: [main.id, scout.id] }).expect(200);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['ok', 'no_scope']);
    expect(esi.calls.every((c) => c.url.includes('clear_other_waypoints=false'))).toBe(true);
  });

  it('acts only on the characters picked', async () => {
    const res = await request(appFor(main.id, owner)).post('/api/character/waypoint')
      .send({ destinationId: 30000142, to: [logi.id] }).expect(200);
    expect(res.body.results).toHaveLength(1);
    expect(esi.calls.map((c) => c.characterId)).toEqual([logi.characterId]);
  });

  it("refuses someone else's character", async () => {
    const otherOwner = (await db.query<{ id: number }>(`INSERT INTO owners DEFAULT VALUES RETURNING id`)).rows[0].id;
    const stranger = await seedChar('Stranger', otherOwner, true);
    await request(appFor(main.id, owner)).post('/api/character/waypoint')
      .send({ destinationId: 30000142, to: [scout.id, stranger.id] }).expect(403);
    expect(esi.calls).toHaveLength(0);
  });

  it('rejects a malformed target list', async () => {
    const app = appFor(main.id, owner);
    for (const to of ['everyone', [], ['x'], Array.from({ length: 51 }, (_, i) => i + 1)]) {
      await request(app).post('/api/character/waypoint').send({ destinationId: 30000142, to }).expect(400);
    }
  });

  it('still sets just the signed-in character when no targets are given', async () => {
    await request(appFor(main.id, owner)).post('/api/character/waypoint')
      .send({ destinationId: 30000142, clearOtherWaypoints: true }).expect(200, { ok: true });
    expect(esi.calls.map((c) => c.characterId)).toEqual([main.characterId]);
  });

  it('works for a session that predates accounts (just the caller)', async () => {
    const solo = await seedChar('Solo', null, true);
    const res = await request(appFor(solo.id, null)).post('/api/character/waypoint')
      .send({ destinationId: 30000142, to: 'allOnline' }).expect(200);
    expect(res.body.results.map((r: { characterName: string }) => r.characterName)).toEqual(['Solo']);
  });
});
