import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { authRouter } from './auth.js';
import { mergeSettings } from '../services/sharedSettings.js';

const dbReady = await ensureIntegrationDb();

function appFor(userId: number, ownerId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = { userId, characterId: userId, ownerId };
    next();
  });
  app.use('/auth', authRouter);
  return app;
}

const row = async (userId: number) =>
  (await db.query<{ ui_settings: Record<string, unknown>; compact_mode: boolean }>(
    'SELECT ui_settings, compact_mode FROM users WHERE id = $1', [userId])).rows[0];

describe('mergeSettings', () => {
  it('lets the most recent character win, keeps unique keys, skips jump skills', () => {
    expect(mergeSettings([
      { id: 1, ui_settings: { a: 1, b: 1, 'nexum.jump.jdc': 5 } },
      { id: 2, ui_settings: { a: 2 } },
    ])).toEqual({ a: 2, b: 1 });
  });
});

describe.skipIf(!dbReady)('shared settings across linked characters (integration)', () => {
  let owner: number;
  let main: number;
  let alt: number;
  beforeEach(async () => {
    await truncateAll();
    owner = (await db.query<{ id: number }>('INSERT INTO owners DEFAULT VALUES RETURNING id')).rows[0].id;
    main = await seedUser({ characterId: 1, name: 'Main' });
    alt  = await seedUser({ characterId: 2, name: 'Alt' });
    await db.query('UPDATE users SET owner_id = $1 WHERE id = ANY($2::int[])', [owner, [main, alt]]);
  });

  it('keeps characters separate while sharing is off', async () => {
    await request(appFor(main, owner)).patch('/auth/settings')
      .send({ entries: { 'nexum.closestSystems.list': [30000142] } });
    expect((await row(alt)).ui_settings).toEqual({});
  });

  it('turning sharing on starts everyone from the most recent character', async () => {
    await db.query(`UPDATE users SET ui_settings = $1, compact_mode = FALSE, settings_updated_at = NOW() - interval '1 day' WHERE id = $2`,
      [{ 'nexum.closestSystems.list': [1], 'nexum.map.heatmap': 'kills' }, main]);
    await db.query(`UPDATE users SET ui_settings = $1, compact_mode = TRUE, settings_updated_at = NOW() WHERE id = $2`,
      [{ 'nexum.closestSystems.list': [2], 'nexum.jump.jdc': 4 }, alt]);
    await db.query(`UPDATE users SET ui_settings = ui_settings || '{"nexum.jump.jdc": 5}' WHERE id = $1`, [main]);

    const r = await request(appFor(main, owner)).put('/auth/share-settings').send({ enabled: true });
    expect(r.status).toBe(200);

    const m = await row(main);
    expect(m.ui_settings['nexum.closestSystems.list']).toEqual([2]); // alt changed last
    expect(m.ui_settings['nexum.map.heatmap']).toBe('kills');        // only main had it
    expect(m.ui_settings['nexum.jump.jdc']).toBe(5);                 // skills stay per character
    expect(m.compact_mode).toBe(true);                               // prefs from the latest
    expect((await row(alt)).ui_settings['nexum.jump.jdc']).toBe(4);
  });

  it('copies changes to linked characters once sharing is on, except jump skills', async () => {
    await request(appFor(main, owner)).put('/auth/share-settings').send({ enabled: true });
    await request(appFor(main, owner)).patch('/auth/settings')
      .send({ entries: { 'nexum.closestSystems.list': [30000142], 'nexum.jump.jdc': 5 } });
    await request(appFor(main, owner)).patch('/auth/preferences').send({ compactMode: true });

    const a = await row(alt);
    expect(a.ui_settings['nexum.closestSystems.list']).toEqual([30000142]);
    expect(a.ui_settings['nexum.jump.jdc']).toBeUndefined();
    expect(a.compact_mode).toBe(true);
  });

  it('stops copying when sharing is turned off', async () => {
    await request(appFor(main, owner)).put('/auth/share-settings').send({ enabled: true });
    await request(appFor(main, owner)).put('/auth/share-settings').send({ enabled: false });
    await request(appFor(main, owner)).patch('/auth/settings')
      .send({ entries: { 'nexum.closestSystems.list': [30000144] } });
    expect((await row(alt)).ui_settings['nexum.closestSystems.list']).toBeUndefined();
  });

  it('reports the sharing state in /auth/me', async () => {
    await request(appFor(main, owner)).put('/auth/share-settings').send({ enabled: true });
    const me = await request(appFor(main, owner)).get('/auth/me');
    expect(me.body.user.shareSettings).toBe(true);
  });
});
