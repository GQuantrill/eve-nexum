import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock config (real db), so the session can be the reports character, whose
// scope is every map and every user.
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown>, sessionUserId: 0 }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { reportsRouter } from './admin.js';

const dbReady = await ensureIntegrationDb();
const REPORTS_CHAR = 777;

function makeApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = { userId: state.sessionUserId, characterId: REPORTS_CHAR };
    next();
  });
  app.use('/api/admin/reports', reportsRouter);
  return app;
}

// No corp/alliance on seeded users, so the report never looks tickers up on ESI.
const pilot = (characterId: number, name: string) => seedUser({ characterId, name });
const event = (userId: number, type: string, hoursAgo: number, mapId: string | null = null, sigType: string | null = null) =>
  db.query(
    `INSERT INTO user_events (user_id, event_type, sig_type, map_id, created_at)
     VALUES ($1, $2, $3, $4, NOW() - ($5 || ' hours')::interval)`,
    [userId, type, sigType, mapId, String(hoursAgo)]);
const ageUser = (userId: number, hoursAgo: number) =>
  db.query(`UPDATE users SET created_at = NOW() - ($2 || ' hours')::interval, updated_at = NOW() - ($2 || ' hours')::interval WHERE id = $1`,
    [userId, String(hoursAgo)]);

type Row = { characterName: string; systemsAdded: number; systemsDeleted: number; sigTypeCounts: Record<string, number> };
async function report(app: express.Express, query: string): Promise<Row[]> {
  const res = await request(app).get(`/api/admin/reports/users${query}`);
  expect(res.status).toBe(200);
  return (res.body as { users: Row[] }).users;
}
const names = (rows: Row[]) => rows.map((r) => r.characterName).filter((n) => n !== 'Reporter').sort();

describe.skipIf(!dbReady)('users report filters (integration)', () => {
  let app: express.Express;
  let mapId: string;
  let busy: number, idle: number, fresh: number;

  beforeEach(async () => {
    await truncateAll();
    state.over = { reportsCharId: REPORTS_CHAR };
    state.sessionUserId = await pilot(REPORTS_CHAR, 'Reporter');
    await ageUser(state.sessionUserId, 24 * 400);
    app = makeApp();

    busy  = await pilot(1, 'Busy');
    idle  = await pilot(2, 'Idle');
    fresh = await pilot(3, 'Fresh');
    await ageUser(busy, 24 * 100);
    await ageUser(idle, 24 * 100);
    await ageUser(fresh, 2);

    const { rows } = await db.query<{ id: string }>(`INSERT INTO maps (user_id, name) VALUES ($1, 'M') RETURNING id`, [busy]);
    mapId = rows[0].id;
    // Busy: a system added this week and one long ago, a recent scan.
    await event(busy, 'system_add', 5, mapId);
    await event(busy, 'system_add', 24 * 60, mapId);
    await event(busy, 'system_delete', 24 * 60, mapId);
    await event(busy, 'signature', 3, mapId, 'wormhole');
    await event(busy, 'signature', 24 * 60, mapId, 'relic');
    // Idle: only old activity.
    await event(idle, 'signature', 24 * 90, mapId, 'data');
  });

  it('active and inactive split users by activity in the window', async () => {
    expect(names(await report(app, '?filter=active&window=week'))).toEqual(['Busy']);
    expect(names(await report(app, '?filter=inactive&window=week'))).toEqual(['Fresh', 'Idle']);
  });

  it('new lists users who first signed in during the window', async () => {
    expect(names(await report(app, '?filter=new&window=24h'))).toEqual(['Fresh']);
    expect(names(await report(app, '?filter=new'))).toEqual(['Busy', 'Fresh', 'Idle']);
  });

  it('systems added / deleted filter on events in the window', async () => {
    expect(names(await report(app, '?filter=systemsAdded&window=week'))).toEqual(['Busy']);
    expect(names(await report(app, '?filter=systemsDeleted&window=week'))).toEqual([]);
    expect(names(await report(app, '?filter=systemsDeleted&window=year'))).toEqual(['Busy']);
  });

  it('a window on all users keeps every row but counts only inside it', async () => {
    const all = await report(app, '?window=week');
    expect(names(all)).toEqual(['Busy', 'Fresh', 'Idle']);
    const b = all.find((r) => r.characterName === 'Busy')!;
    expect(b.systemsAdded).toBe(1);
    expect(b.systemsDeleted).toBe(0);
    expect(b.sigTypeCounts).toEqual({ wormhole: 1 });

    const lifetime = (await report(app, '')).find((r) => r.characterName === 'Busy')!;
    expect(lifetime.systemsAdded).toBe(2);
    expect(lifetime.sigTypeCounts).toEqual({ wormhole: 1, relic: 1 });
  });
});
