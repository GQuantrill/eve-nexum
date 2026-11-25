import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { adminRouter } from './admin.js';
import { backgroundsRouter } from './backgrounds.js';

const dbReady = await ensureIntegrationDb();

const CORP = 98000001, OTHER_CORP = 98000002;
// The smallest bytes each type is recognised by.
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function appFor(userId: number, corpId: number | null) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: userId, userCorpId: corpId, userAllianceId: null,
    };
    next();
  });
  app.use('/api/admin', adminRouter);
  app.use('/api/backgrounds', backgroundsRouter);
  return app;
}

describe.skipIf(!dbReady)('org map backgrounds (integration)', () => {
  let admin: number, member: number, otherMember: number;

  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, allianceMode: false, restrictedMode: true };
    admin       = await seedUser({ characterId: 1, corpId: CORP, role: 'admin' });
    member      = await seedUser({ characterId: 2, corpId: CORP, role: 'readonly' });
    otherMember = await seedUser({ characterId: 3, corpId: OTHER_CORP, role: 'readonly' });
  });

  const add = (app: express.Express, buf: Buffer, name = '') =>
    request(app).post('/api/admin/backgrounds').send({ data: buf.toString('base64'), name });

  it('adds up to five, the first the default, and members see them', async () => {
    const a = appFor(admin, CORP);
    const first = await add(a, WEBP, 'Nebula');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ name: 'Nebula', isDefault: true });
    for (let i = 0; i < 4; i++) expect((await add(a, PNG)).status).toBe(200);
    expect((await add(a, PNG)).status).toBe(409);

    const list = await request(appFor(member, CORP)).get('/api/backgrounds');
    expect(list.body.enabled).toBe(true);
    expect(list.body.backgrounds).toHaveLength(5);
    const img = await request(appFor(member, CORP)).get(`/api/backgrounds/${first.body.id}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses what is not a picture, and pictures that are too big', async () => {
    const a = appFor(admin, CORP);
    expect((await add(a, Buffer.from('<svg onload=alert(1)>'))).status).toBe(400);
    expect((await add(a, Buffer.concat([WEBP, Buffer.alloc(800 * 1024)]))).status).toBe(413);
  });

  it('keeps each corp to its own', async () => {
    const { body } = await add(appFor(admin, CORP), WEBP);
    expect((await request(appFor(otherMember, OTHER_CORP)).get('/api/backgrounds')).body.backgrounds).toEqual([]);
    expect((await request(appFor(otherMember, OTHER_CORP)).get(`/api/backgrounds/${body.id}`)).status).toBe(404);
  });

  it('moves the default, clears it, renames and deletes', async () => {
    const a = appFor(admin, CORP);
    const one = (await add(a, WEBP)).body, two = (await add(a, PNG)).body;
    await request(a).put('/api/admin/backgrounds/default').send({ id: two.id }).expect(200);
    let list = (await request(a).get('/api/admin/backgrounds')).body.backgrounds;
    expect(list.map((b: { isDefault: boolean }) => b.isDefault)).toEqual([false, true]);
    await request(a).put('/api/admin/backgrounds/default').send({ id: null }).expect(200);
    await request(a).patch(`/api/admin/backgrounds/${one.id}`).send({ name: '  Home\u0007 sky ' }).expect(200);
    await request(a).delete(`/api/admin/backgrounds/${two.id}`).expect(200);
    list = (await request(a).get('/api/admin/backgrounds')).body.backgrounds;
    expect(list).toEqual([{ id: one.id, name: 'Home sky', isDefault: false }]);
  });

  it('is members-only to manage, and off on a solo install', async () => {
    expect((await add(appFor(member, CORP), WEBP)).status).toBe(403);
    state.over = { corpMode: false, allianceMode: false, restrictedMode: false };
    expect((await add(appFor(admin, CORP), WEBP)).status).toBe(400);
    expect((await request(appFor(member, CORP)).get('/api/backgrounds')).body).toEqual({ enabled: false, backgrounds: [] });
  });
});
