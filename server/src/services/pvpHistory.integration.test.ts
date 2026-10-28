import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ensureIntegrationDb, truncateAll } from '../test/integrationDb.js';
import { db } from '../db.js';
import {
  recordPvpKill, flushPvpKills, prunePvpHistory, getPvpForecast, resetPvpCaches,
  hourFloor, pendingCount, PVP_HISTORY_DAYS,
} from './pvpHistory.js';
import activityRouter from '../routes/activity.js';

const dbReady = await ensureIntegrationDb();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JITA = 30000142;
const J_SPACE = 31000005;

// Today at the given UTC hour, minutes in, or that many days back.
function at(hourUtc: number, daysAgo = 0, minutes = 10): number {
  const d = new Date();
  d.setUTCHours(hourUtc, minutes, 0, 0);
  return d.getTime() - daysAgo * DAY - (d.getTime() > Date.now() ? DAY : 0);
}

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

  it('folds the history into 24 UTC hours of the day', async () => {
    recordPvpKill(JITA, at(18, 1));
    recordPvpKill(JITA, at(18, 5));
    recordPvpKill(JITA, at(18, 30));
    recordPvpKill(JITA, at(3, 2));
    recordPvpKill(J_SPACE, at(18, 1)); // another system: not counted
    await flushPvpKills();

    const f = await getPvpForecast(JITA);
    expect(f.byHour).toHaveLength(24);
    expect(f.byHour[18]).toBe(3);
    expect(f.byHour[3]).toBe(1);
    expect(f.total).toBe(4);
    // History reaches back ~30 days, not the full 90 yet.
    expect(f.days).toBeGreaterThanOrEqual(30);
    expect(f.days).toBeLessThanOrEqual(31);
  });

  it('answers an empty forecast for a quiet system', async () => {
    const f = await getPvpForecast(JITA);
    expect(f).toEqual({ byHour: new Array(24).fill(0), total: 0, days: 0 });
  });

  it('prunes hours older than the window and leaves them out of the forecast', async () => {
    await db.query(
      `INSERT INTO system_pvp_hours (eve_system_id, hour, kills) VALUES
         ($1, NOW() - make_interval(days => $2), 7),
         ($1, date_trunc('hour', NOW()) - interval '1 day', 2)`,
      [JITA, PVP_HISTORY_DAYS + 2]);
    expect((await getPvpForecast(JITA)).total).toBe(2);
    expect(await prunePvpHistory()).toBe(1);
    expect((await db.query('SELECT 1 FROM system_pvp_hours')).rowCount).toBe(1);
  });

  it('serves the forecast over the activity route to a logged-in user, and refuses a bad id', async () => {
    recordPvpKill(J_SPACE, at(20, 1));
    await flushPvpKills();
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
    expect(ok.body.byHour[20]).toBe(1);
    expect(ok.body.total).toBe(1);
    expect((await request(app).get('/api/activity/pvp/99999999999')).status).toBe(400);
  });
});
