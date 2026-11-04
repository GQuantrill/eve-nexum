import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// How ESI answers each call: a status, or 'throw' for a network failure.
const esi = vi.hoisted(() => ({
  online:   200 as number | 'throw',
  location: 200 as number | 'throw',
  token:    true,
}));
vi.mock('../utils/eveToken.js', () => ({
  getValidToken: vi.fn(async () => {
    if (!esi.token) throw new Error('refresh failed');
    return 'tok';
  }),
}));
vi.mock('../utils/esi.js', () => ({
  esiFetch: vi.fn(async (url: string) => {
    const how = url.includes('/online/') ? esi.online : url.includes('/location/') ? esi.location : 200;
    if (how === 'throw') throw new TypeError('fetch failed');
    if (how !== 200) return new Response('{}', { status: how });
    if (url.includes('/online/')) return new Response(JSON.stringify({ online: true }), { status: 200 });
    if (url.includes('/location/')) return new Response(JSON.stringify({ solar_system_id: 30000142 }), { status: 200 });
    return new Response(JSON.stringify({ ship_item_id: 1, ship_type_id: 670, ship_name: 'x' }), { status: 200 });
  }),
}));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { characterRouter } from './character.js';

const dbReady = await ensureIntegrationDb();

function appFor(userId: number) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: 1, characterName: 'Main', role: 'full', ownerId: null,
    };
    next();
  });
  app.use('/api/character', characterRouter);
  return app;
}

// A fresh character per test, so the location cache never carries over.
let nextChar = 9_100_000;
const seed = () => seedUser({ characterId: ++nextChar, name: `P${nextChar}`, role: 'full' });

describe.skipIf(!dbReady)('GET /api/character/location when ESI fails', () => {
  beforeEach(async () => {
    await truncateAll();
    esi.online = 200; esi.location = 200; esi.token = true;
  });

  // An "offline" answer resets the jump tracker; a failed read must not.
  it('answers 503, not offline, when the location read fails', async () => {
    esi.location = 502;
    const res = await request(appFor(await seed())).get('/api/character/location');
    expect(res.status).toBe(503);
  });

  it('answers 503 when the online check fails', async () => {
    esi.online = 503;
    const res = await request(appFor(await seed())).get('/api/character/location');
    expect(res.status).toBe(503);
  });

  it('answers 503 on a network failure', async () => {
    esi.location = 'throw';
    const res = await request(appFor(await seed())).get('/api/character/location');
    expect(res.status).toBe(503);
  });

  it('still says offline when the token is unusable', async () => {
    esi.token = false;
    const res = await request(appFor(await seed())).get('/api/character/location');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ online: false });
  });

  it('reports the system when ESI answers', async () => {
    const res = await request(appFor(await seed())).get('/api/character/location');
    expect(res.status).toBe(200);
    expect(res.body.online).toBe(true);
  });
});
