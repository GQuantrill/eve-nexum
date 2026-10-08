import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { authRouter } from './auth.js';

const dbReady = await ensureIntegrationDb();

function appFor(userId: number) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = { userId, characterId: userId };
    next();
  });
  app.use('/auth', authRouter);
  return app;
}

// A prefix that accepts any suffix — the thing that made unbounded growth
// possible in the first place.
const key = (n: number) => `nexum.panel.collapsed.k${n}`;

const settingsOf = async (userId: number) =>
  (await db.query<{ ui_settings: Record<string, unknown> }>(
    'SELECT ui_settings FROM users WHERE id = $1', [userId])).rows[0].ui_settings;

describe.skipIf(!dbReady)('ui_settings caps (integration)', () => {
  let user: number;
  beforeEach(async () => {
    await truncateAll();
    user = await seedUser({ characterId: 1, name: 'Capper' });
  });

  it('stores settings normally below the cap', async () => {
    const r = await request(appFor(user)).patch('/auth/settings')
      .send({ entries: { [key(1)]: true, [key(2)]: false } });
    expect(r.status).toBe(200);
    expect(Object.keys(await settingsOf(user))).toHaveLength(2);
  });

  it('refuses to grow past the key cap, and writes nothing when it refuses', async () => {
    const bulk: Record<string, unknown> = {};
    for (let i = 0; i < 501; i++) bulk[key(i)] = true;
    const r = await request(appFor(user)).patch('/auth/settings').send({ entries: bulk });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('settings_too_large');
    // Partially applying would leave the client and server disagreeing.
    expect(Object.keys(await settingsOf(user))).toHaveLength(0);
  });

  it('refuses to grow past the size cap', async () => {
    const big = 'x'.repeat(300 * 1024);
    const r = await request(appFor(user)).patch('/auth/settings')
      .send({ entries: { [key(1)]: big } });
    expect(r.status).toBe(413);
    expect(Object.keys(await settingsOf(user))).toHaveLength(0);
  });

  it('still lets an account at the key cap change a key it already has', async () => {
    // The cap restricts GROWTH. Someone sitting on the limit must not be
    // locked out of their own settings.
    const bulk: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) bulk[key(i)] = true;
    expect((await request(appFor(user)).patch('/auth/settings').send({ entries: bulk })).status).toBe(200);

    const update = await request(appFor(user)).patch('/auth/settings')
      .send({ entries: { [key(0)]: 'changed' } });
    expect(update.status).toBe(200);
    expect((await settingsOf(user))[key(0)]).toBe('changed');

    // ...but one more NEW key is still refused.
    const grow = await request(appFor(user)).patch('/auth/settings')
      .send({ entries: { [key(999)]: true } });
    expect(grow.status).toBe(413);
  });

  it('lets an oversized account shrink a value back down', async () => {
    const bulk: Record<string, unknown> = {};
    for (let i = 0; i < 400; i++) bulk[key(i)] = 'y'.repeat(500);
    expect((await request(appFor(user)).patch('/auth/settings').send({ entries: bulk })).status).toBe(200);
    const shrink = await request(appFor(user)).patch('/auth/settings')
      .send({ entries: { [key(0)]: '' } });
    expect(shrink.status).toBe(200);
  });
});
