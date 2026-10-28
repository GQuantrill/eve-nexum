import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// zKillboard stand-in: a grid, or null for "zKill unreachable".
const zk = vi.hoisted(() => ({ grid: null as number[][] | null }));
vi.mock('./zkillActivity.js', async (importActual) => {
  const actual = await importActual<typeof import('./zkillActivity.js')>();
  return { ...actual, fetchZkillActivity: vi.fn(async () => zk.grid) };
});

import { ensureIntegrationDb, truncateAll } from '../test/integrationDb.js';
import { db } from '../db.js';
import {
  recordPvpKill, flushPvpKills, prunePvpHistory, getPvpForecast, getLocalGrid, recentPvpKills,
  resetPvpCaches, hourFloor, pendingCount, PVP_HISTORY_DAYS,
} from './pvpHistory.js';
import { emptyGrid } from './zkillActivity.js';
import activityRouter from '../routes/activity.js';

const dbReady = await ensureIntegrationDb();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JITA = 30000142;
const J_SPACE = 31000005;

// That many days back, at the given UTC hour (ten minutes in), never in the future.
function at(hourUtc: number, daysAgo = 0): number {
  const d = new Date();
  d.setUTCHours(hourUtc, 10, 0, 0);
  return d.getTime() - daysAgo * DAY - (d.getTime() > Date.now() ? DAY : 0);
}
const dow = (ms: number) => new Date(ms).getUTCDay();

describe('hourFloor', () => {
  it('drops to the start of the UTC hour', () => {
    expect(hourFloor(Date.UTC(2026, 9, 28, 18, 59, 59))).toBe(Date.UTC(2026, 9, 28, 18));
    expect(hourFloor(Date.UTC(2026, 9, 28, 18))).toBe(Date.UTC(2026, 9, 28, 18));
  });
});

describe('recordPvpKill', () => {
  beforeEach(() => resetPvpCaches());

  it('buckets kills by system and hour', () => {
    const now = Date.UTC(2026, 9, 28, 12);
    recordPvpKill(JITA, now - 10 * 60_000, now);
    recordPvpKill(JITA, now - 20 * 60_000, now);
    recordPvpKill(JITA, now - 2 * HOUR, now);
    recordPvpKill(J_SPACE, now - 10 * 60_000, now);
    expect(pendingCount()).toBe(3);
  });

  it('ignores junk: bad system ids, future times, kills past the window', () => {
    const now = Date.UTC(2026, 9, 28, 12);
    recordPvpKill(0, now, now);
    recordPvpKill(-5, now, now);
    recordPvpKill(1.5, now, now);
    recordPvpKill(JITA, now + 2 * HOUR, now);
    recordPvpKill(JITA, now - (PVP_HISTORY_DAYS + 1) * DAY, now);
    expect(pendingCount()).toBe(0);
  });
});

describe.skipIf(!dbReady)('PvP history (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    resetPvpCaches();
    zk.grid = null;
  });

  it('flushes counts and adds to an hour already on record', async () => {
    recordPvpKill(JITA, at(18));
    recordPvpKill(JITA, at(18));
    await flushPvpKills();
    expect(pendingCount()).toBe(0);
    recordPvpKill(JITA, at(18));
    await flushPvpKills();
    const { rows } = await db.query<{ kills: number }>(`SELECT kills FROM system_pvp_hours WHERE eve_system_id = $1`, [JITA]);
    expect(rows).toEqual([{ kills: 3 }]);
  });

  it('builds our own weekday/hour grid from the recorded feed', async () => {
    const a = at(18, 1), b = at(18, 8), c = at(3, 2);
    recordPvpKill(JITA, a);
    recordPvpKill(JITA, b);
    recordPvpKill(JITA, c);
    recordPvpKill(J_SPACE, a); // another system: not counted
    await flushPvpKills();

    const local = await getLocalGrid(JITA);
    // a and b are a week apart: same weekday, same hour.
    expect(local.grid[dow(a)][18]).toBe(2);
    expect(local.grid[dow(c)][3]).toBe(1);
    expect(local.total).toBe(3);
    expect(local.days).toBeGreaterThanOrEqual(8);
    expect(local.days).toBeLessThanOrEqual(9);
  });

  it('counts the last 24 hours, including kills not yet flushed', async () => {
    recordPvpKill(JITA, Date.now() - 2 * HOUR);
    recordPvpKill(JITA, Date.now() - 3 * DAY); // too old for this count
    await flushPvpKills();
    recordPvpKill(JITA, Date.now() - 60_000);  // still pending
    expect(await recentPvpKills(JITA)).toBe(2);
  });

  it("uses zKill's grid when it has one, with the live count alongside", async () => {
    const grid = emptyGrid();
    grid[2][18] = 40;
    grid[5][3] = 2;
    zk.grid = grid;
    recordPvpKill(JITA, Date.now() - HOUR);

    const f = await getPvpForecast(JITA);
    expect(f).toMatchObject({ source: 'zkill', total: 42, days: 90, recent24h: 1 });
    expect(f.grid[2][18]).toBe(40);
  });

  it("falls back to our own recording when zKill can't be reached", async () => {
    const t = at(20, 1);
    recordPvpKill(J_SPACE, t);
    await flushPvpKills();
    const f = await getPvpForecast(J_SPACE);
    expect(f.source).toBe('live');
    expect(f.grid[dow(t)][20]).toBe(1);
    expect(f.total).toBe(1);
  });

  it('answers an empty forecast for a quiet system with no zKill history', async () => {
    zk.grid = emptyGrid();
    expect(await getPvpForecast(JITA)).toEqual({ source: 'zkill', grid: emptyGrid(), total: 0, days: 90, recent24h: 0 });
  });

  it('prunes hours older than the window', async () => {
    await db.query(
      `INSERT INTO system_pvp_hours (eve_system_id, hour, kills) VALUES
         ($1, NOW() - make_interval(days => $2), 7),
         ($1, date_trunc('hour', NOW()) - interval '1 day', 2)`,
      [JITA, PVP_HISTORY_DAYS + 2]);
    expect((await getLocalGrid(JITA)).total).toBe(2);
    expect(await prunePvpHistory()).toBe(1);
    expect((await db.query('SELECT 1 FROM system_pvp_hours')).rowCount).toBe(1);
  });

  it('serves the forecast over the activity route to a logged-in user, and refuses a bad id', async () => {
    zk.grid = emptyGrid();
    zk.grid[1][20] = 3;
    const makeApp = (session: object) => {
      const app = express();
      app.use((req, _res, next) => { (req as express.Request & { session: object }).session = session; next(); });
      app.use('/api/activity', activityRouter);
      return app;
    };
    // Same gate as the rest of /api/activity: a login or a share link.
    expect((await request(makeApp({})).get(`/api/activity/pvp/${J_SPACE}`)).status).toBe(401);
    const app = makeApp({ userId: 1 });
    const ok = await request(app).get(`/api/activity/pvp/${J_SPACE}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ source: 'zkill', total: 3, days: 90 });
    expect(ok.body.grid[1][20]).toBe(3);
    expect((await request(app).get('/api/activity/pvp/99999999999')).status).toBe(400);
  });
});
