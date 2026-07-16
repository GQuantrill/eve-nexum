import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock config (real db). A Proxy over the real config with live-mutable overrides.
// sessionUserId drives the fake auth middleware below.
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown>, sessionUserId: 0 }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser, seedSession, liveSessionCount } from '../test/integrationDb.js';
import { db } from '../db.js';
import { adminRouter } from './admin.js';

const dbReady = await ensureIntegrationDb();

// A bare app that mounts the real adminRouter (requireAdmin included) behind a
// fake session. requireAdmin re-checks the role against the real DB, so seeding
// an admin user is what actually authorises the request.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = { userId: state.sessionUserId, characterId: 777 };
    next();
  });
  app.use('/api/admin', adminRouter);
  return app;
}

const corpStanding = (contactId: number, standing: number) =>
  db.query(`INSERT INTO corp_standings (corp_id, contact_kind, contact_id, standing, updated_at) VALUES (1000, 'corporation', $1, $2, NOW())`, [contactId, standing]);

describe.skipIf(!dbReady)('admin access-grants endpoints (integration)', () => {
  let app: express.Express;

  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, allianceMode: false, corpIds: [1000], allianceIds: [2000], restrictedMode: true, adminCharId: 777 };
    const adminId = await seedUser({ characterId: 777, corpId: 1000, role: 'admin' });
    state.sessionUserId = adminId;
    app = makeApp();
  });

  it('rejects an unauthenticated request', async () => {
    state.sessionUserId = 0; // falsy → requireAdmin returns 401
    const res = await request(app).post('/api/admin/access-grants').send({ kind: 'corp', eveId: 500 });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin session', async () => {
    const plebId = await seedUser({ characterId: 12, corpId: 1000, role: 'readonly' });
    state.sessionUserId = plebId;
    const res = await request(app).post('/api/admin/access-grants').send({ kind: 'corp', eveId: 500 });
    expect(res.status).toBe(403);
  });

  it('adds a corp grant held at positive standing (201)', async () => {
    await corpStanding(500, 10);
    const res = await request(app).post('/api/admin/access-grants').send({ kind: 'corp', eveId: 500 });
    expect(res.status).toBe(201);
    const { rows } = await db.query(`SELECT source FROM access_grants WHERE kind='corp' AND eve_id=500`);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('admin');
  });

  it('refuses a corp grant with no positive standing (403 standing_not_positive)', async () => {
    const res = await request(app).post('/api/admin/access-grants').send({ kind: 'corp', eveId: 500 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('standing_not_positive');
    const { rows } = await db.query(`SELECT 1 FROM access_grants WHERE kind='corp' AND eve_id=500`);
    expect(rows).toHaveLength(0); // nothing written
  });

  it('adds a character grant with no standing check (201, exempt)', async () => {
    const res = await request(app).post('/api/admin/access-grants').send({ kind: 'character', eveId: 42 });
    expect(res.status).toBe(201);
  });

  it('refuses to delete an env-seeded grant (400 env_immutable)', async () => {
    const { rows } = await db.query<{ id: string }>(`INSERT INTO access_grants (kind, eve_id, source) VALUES ('corp', 500, 'env') RETURNING id`);
    const res = await request(app).delete(`/api/admin/access-grants/${rows[0].id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('env_immutable');
    const check = await db.query(`SELECT 1 FROM access_grants WHERE id=$1`, [rows[0].id]);
    expect(check.rows).toHaveLength(1); // still there
  });

  it('deleting an admin grant evicts the sessions it solely admitted', async () => {
    const { rows } = await db.query<{ id: string }>(`INSERT INTO access_grants (kind, eve_id, source) VALUES ('corp', 555, 'admin') RETURNING id`);
    const u = await seedUser({ characterId: 5, corpId: 555 }); // admitted only by this grant
    await seedSession(u);
    const res = await request(app).delete(`/api/admin/access-grants/${rows[0].id}`);
    expect(res.status).toBe(200);
    expect(res.body.sessionsKilled).toBe(1);
    expect(await liveSessionCount(u)).toBe(0);
  });
});
