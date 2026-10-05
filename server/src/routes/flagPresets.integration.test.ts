import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { adminRouter } from './admin.js';
import { flagPresetsRouter } from './flagPresets.js';

const dbReady = await ensureIntegrationDb();

const CORP = 98000001, OTHER_CORP = 98000002, ALLY = 99000001;
const PRESET = { id: 'p1', name: 'DO NOT ROLL', icon: 'SkullIcon', color: '#e05a5a' };

// requireAdmin re-reads the role from the DB, so seeding the user is what
// authorises the request — the session below only carries identity.
function appFor(userId: number, corpId: number | null, allianceId: number | null = null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: userId, userCorpId: corpId, userAllianceId: allianceId,
    };
    next();
  });
  app.use('/api/admin', adminRouter);
  app.use('/api/flag-presets', flagPresetsRouter);
  return app;
}

describe.skipIf(!dbReady)('flag presets (integration)', () => {
  let admin: number, member: number, otherAdmin: number;

  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, allianceMode: false };
    admin      = await seedUser({ characterId: 1, corpId: CORP,       role: 'admin'    });
    member     = await seedUser({ characterId: 2, corpId: CORP,       role: 'readonly' });
    otherAdmin = await seedUser({ characterId: 3, corpId: OTHER_CORP, role: 'admin'    });
  });

  it('saves a corp preset and reads it back to the admin', async () => {
    const app = appFor(admin, CORP);
    await request(app).put('/api/admin/flag-presets').send({ presets: [PRESET] }).expect(200);
    const { body } = await request(app).get('/api/admin/flag-presets').expect(200);
    expect(body.scope).toBe('corp');
    expect(body.presets).toEqual([PRESET]);
  });

  it('shows an ordinary member the preset their admin set', async () => {
    await request(appFor(admin, CORP)).put('/api/admin/flag-presets').send({ presets: [PRESET] }).expect(200);
    const { body } = await request(appFor(member, CORP)).get('/api/flag-presets').expect(200);
    expect(body).toEqual([PRESET]);
  });

  it('does not let an ordinary member write presets', async () => {
    await request(appFor(member, CORP)).put('/api/admin/flag-presets').send({ presets: [PRESET] }).expect(403);
    const { rows } = await db.query(`SELECT 1 FROM corp_flag_presets WHERE corp_id = $1`, [CORP]);
    expect(rows).toHaveLength(0);                       // nothing written
  });

  it('keeps one corp out of another corp s presets', async () => {
    await request(appFor(admin, CORP)).put('/api/admin/flag-presets').send({ presets: [PRESET] }).expect(200);

    // Control: the corp that saved it does see it, so the emptiness below is
    // about scoping rather than the save having failed.
    const ours = await request(appFor(admin, CORP)).get('/api/admin/flag-presets').expect(200);
    expect(ours.body.presets).toHaveLength(1);

    const theirs = await request(appFor(otherAdmin, OTHER_CORP)).get('/api/admin/flag-presets').expect(200);
    expect(theirs.body.presets).toEqual([]);

    // And writing as the other corp must not touch the first corp's row.
    await request(appFor(otherAdmin, OTHER_CORP))
      .put('/api/admin/flag-presets')
      .send({ presets: [{ ...PRESET, name: 'THEIRS' }] }).expect(200);
    const after = await request(appFor(admin, CORP)).get('/api/admin/flag-presets').expect(200);
    expect(after.body.presets[0].name).toBe('DO NOT ROLL');
  });

  it('writes the alliance row for an alliance admin, not the corp row', async () => {
    state.over = { corpMode: true, allianceMode: true };
    const aAdmin = await seedUser({ characterId: 4, corpId: CORP, allianceId: ALLY, role: 'alliance_admin' });
    await request(appFor(aAdmin, CORP, ALLY))
      .put('/api/admin/flag-presets').send({ presets: [PRESET] }).expect(200);

    const alliance = await db.query(`SELECT presets FROM alliance_flag_presets WHERE alliance_id = $1`, [ALLY]);
    expect(alliance.rows).toHaveLength(1);
    const corp = await db.query(`SELECT 1 FROM corp_flag_presets WHERE corp_id = $1`, [CORP]);
    expect(corp.rows).toHaveLength(0);
  });

  it('shows an alliance member the alliance presets, not just their corp s', async () => {
    // The point of this case: a plain member is NOT an alliance admin, so the
    // write rule would have pointed them at their corp and they would never see
    // what the alliance admin set.
    state.over = { corpMode: true, allianceMode: true };
    const aAdmin  = await seedUser({ characterId: 5, corpId: CORP, allianceId: ALLY, role: 'alliance_admin' });
    const aMember = await seedUser({ characterId: 6, corpId: CORP, allianceId: ALLY, role: 'readonly' });
    await request(appFor(aAdmin, CORP, ALLY))
      .put('/api/admin/flag-presets').send({ presets: [PRESET] }).expect(200);

    const { body } = await request(appFor(aMember, CORP, ALLY)).get('/api/flag-presets').expect(200);
    expect(body).toEqual([PRESET]);
  });

  it('falls back to corp presets when the alliance has none', async () => {
    state.over = { corpMode: true, allianceMode: true };
    await db.query(`INSERT INTO corp_flag_presets (corp_id, presets) VALUES ($1, $2::jsonb)`,
      [CORP, JSON.stringify([PRESET])]);
    const aMember = await seedUser({ characterId: 7, corpId: CORP, allianceId: ALLY, role: 'readonly' });
    const { body } = await request(appFor(aMember, CORP, ALLY)).get('/api/flag-presets').expect(200);
    expect(body).toEqual([PRESET]);
  });

  it('rejects presets the connection PATCH would refuse, without storing any', async () => {
    const app = appFor(admin, CORP);
    const bad = [
      { label: 'bad colour',  presets: [{ ...PRESET, color: 'red' }] },
      { label: 'css smuggle', presets: [{ ...PRESET, color: '#fff;background:url(x)' }] },
      { label: 'no icon',     presets: [{ ...PRESET, icon: '' }] },
      { label: 'long icon',   presets: [{ ...PRESET, icon: 'x'.repeat(65) }] },
      { label: 'long name',   presets: [{ ...PRESET, name: 'x'.repeat(201) }] },
      { label: 'duplicate',   presets: [PRESET, PRESET] },
      { label: 'not a list',  presets: { id: 'p1' } },
    ];
    for (const c of bad) {
      await request(app).put('/api/admin/flag-presets').send({ presets: c.presets }).expect(400);
    }
    const { rows } = await db.query(`SELECT 1 FROM corp_flag_presets WHERE corp_id = $1`, [CORP]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a list longer than the cap', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...PRESET, id: `p${i}` }));
    await request(appFor(admin, CORP)).put('/api/admin/flag-presets').send({ presets: many }).expect(400);
  });

  it('records the change in the audit log', async () => {
    await request(appFor(admin, CORP)).put('/api/admin/flag-presets').send({ presets: [PRESET] }).expect(200);
    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM admin_audit WHERE action = 'flag_presets_update'`);
    expect(rows).toHaveLength(1);
  });
});
