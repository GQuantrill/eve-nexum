import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ensureIntegrationDb, truncateAll } from '../test/integrationDb.js';
import { db } from '../db.js';
import { systemsRouter } from './systems.js';

const dbReady = await ensureIntegrationDb();

function makeApp() {
  const app = express();
  app.use('/api/systems', systemsRouter);
  return app;
}

// The desktop app turns the system named in EVE's Local log into a map system
// through this lookup.
describe.skipIf(!dbReady)('GET /api/systems/lookup', () => {
  beforeEach(async () => {
    await truncateAll();
    await db.query(`INSERT INTO solar_systems (id, name, class) VALUES (30000142, 'Jita', 'HS'), (31000005, 'Thera', 'C12')`);
  });

  it('finds a system by its exact name, any case', async () => {
    const res = await request(makeApp()).get('/api/systems/lookup?name=jita');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ eveSystemId: 30000142, name: 'Jita', systemClass: 'HS', effect: 'none' });
  });

  it('does not match on a prefix', async () => {
    const res = await request(makeApp()).get('/api/systems/lookup?name=Jit');
    expect(res.status).toBe(404);
  });

  it('looks up a batch, answering only the systems', async () => {
    const res = await request(makeApp()).get('/api/systems/lookup?names=Kihiro,JITA,thera,Shihari');
    expect(res.status).toBe(200);
    expect(res.body.map((s: { name: string }) => s.name).sort()).toEqual(['Jita', 'Thera']);
  });

  it('refuses an empty or oversized batch', async () => {
    expect((await request(makeApp()).get('/api/systems/lookup?names=')).status).toBe(400);
    const many = Array.from({ length: 61 }, (_, i) => `sys${i}`).join(',');
    expect((await request(makeApp()).get(`/api/systems/lookup?names=${many}`)).status).toBe(400);
  });

  it('refuses a missing or oversized name', async () => {
    expect((await request(makeApp()).get('/api/systems/lookup')).status).toBe(400);
    expect((await request(makeApp()).get(`/api/systems/lookup?name=${'x'.repeat(65)}`)).status).toBe(400);
  });
});
