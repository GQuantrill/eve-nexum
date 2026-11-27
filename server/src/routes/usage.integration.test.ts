import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { ensureIntegrationDb, truncateAll } from '../test/integrationDb.js';
import { db } from '../db.js';
import { telemetryRouter } from './telemetry.js';
import { usageRouter } from './usage.js';
import { buildUsageReport, createUsageShare, deleteUsageShare } from '../services/usageStats.js';
import { getInstanceId } from '../services/telemetry.js';

const dbReady = await ensureIntegrationDb();

const app = express();
app.use(express.json());
app.use('/api/telemetry', telemetryRouter);
app.use('/api/usage', usageRouter);

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!dbReady)('usage figures (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    // The install id lives in sde_meta, which the SDE import makes, not migrate.
    await db.query(`CREATE TABLE IF NOT EXISTS sde_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`TRUNCATE telemetry_daily, telemetry_pings, usage_share`);
  });

  it('keeps a daily history of each install, with only the known counts', async () => {
    const ping = (instanceId: string, stats: object) =>
      request(app).post('/api/telemetry').send({ version: '6.5.0', instanceId, mapCount: 3, userCount: 9, stats });
    expect((await ping(A, { active30d: 7, accounts30d: 5, evil: 'x', mode: 'corp', features: { chainNumbering: 2, nope: 1 },
      languages: { de: 3, 'not-a-lang': 4 } })).status).toBe(204);
    expect((await ping(A, { active30d: 8 })).status).toBe(204); // same day: replaced
    const { rows } = await db.query<{ stats: Record<string, unknown> }>(`SELECT stats FROM telemetry_daily WHERE instance_id = $1`, [A]);
    expect(rows).toHaveLength(1);
    expect(rows[0].stats).toEqual({ active30d: 8, mapCount: 3, userCount: 9 });
    await ping(B, { active30d: 7, accounts30d: 5, evil: 'x', mode: 'corp', features: { chainNumbering: 2, nope: 1 }, languages: { de: 3, 'not-a-lang': 4 } });
    const { rows: [b] } = await db.query<{ stats: Record<string, unknown> }>(`SELECT stats FROM telemetry_daily WHERE instance_id = $1`, [B]);
    expect(b.stats).toEqual({ active30d: 7, accounts30d: 5, mode: 'corp', features: { chainNumbering: 2 }, languages: { de: 3 }, mapCount: 3, userCount: 9 });
  });

  it('sums self-hosted installs by month from each one\'s last ping that month, leaving this site out', async () => {
    const self = await getInstanceId();
    const month = new Date().toISOString().slice(0, 7);
    await db.query(
      `INSERT INTO telemetry_daily (instance_id, day, version, stats) VALUES
         ($1, CURRENT_DATE - 1, '6.4.0', '{"active30d": 10}'),
         ($1, CURRENT_DATE,     '6.5.0', '{"active30d": 12, "accounts30d": 9, "mode": "corp"}'),
         ($2, CURRENT_DATE,     '6.5.0', '{"active30d": 30}'),
         ($3, CURRENT_DATE,     '6.0.0', '{}'),
         ($4, CURRENT_DATE,     '6.5.0', '{"active30d": 500}')`,
      [A, B, '33333333-3333-4333-8333-333333333333', self]);
    const r = await buildUsageReport();
    const m = r.months.find((x) => x.month === month)!;
    expect(m.selfHosted).toBe(42);
    expect(m.selfHostedInstances).toBe(3);
    expect(r.current.selfHosted30d).toBe(42);
    expect(r.current.selfHostedInstances).toBe(3);
    expect(r.current.instancesWithoutCounts).toBe(1);
    expect(r.breakdown.modes).toEqual({ corp: 1 });
    expect(r.months).toHaveLength(12);
  });

  it('serves the page only through the live link', async () => {
    expect((await request(app).get('/api/usage/abcdefghijklmnopqrstuvwx')).status).toBe(404);
    const token = await createUsageShare();
    const ok = await request(app).get(`/api/usage/${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.report.months).toHaveLength(12);
    const next = await createUsageShare();
    expect((await request(app).get(`/api/usage/${token}`)).status).toBe(404);
    await deleteUsageShare();
    expect((await request(app).get(`/api/usage/${next}`)).status).toBe(404);
  });
});
