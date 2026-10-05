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
import { applyPrefsToNewUser, orgScopeFor, readDefaults } from '../services/uiDefaults.js';

const dbReady = await ensureIntegrationDb();
const CORP = 98000001, OTHER_CORP = 98000002;

function appFor(userId: number, corpId: number | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: userId, userCorpId: corpId, userAllianceId: null,
    };
    next();
  });
  app.use('/api/admin', adminRouter);
  return app;
}

describe.skipIf(!dbReady)('org UI defaults (integration)', () => {
  let admin: number, member: number, otherAdmin: number;

  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, allianceMode: false };
    admin      = await seedUser({ characterId: 1, corpId: CORP,       role: 'admin'    });
    member     = await seedUser({ characterId: 2, corpId: CORP,       role: 'readonly' });
    otherAdmin = await seedUser({ characterId: 3, corpId: OTHER_CORP, role: 'admin'    });
  });

  it('captures the admin own configuration without being sent one', async () => {
    await db.query(
      `UPDATE users SET ui_settings = $1::jsonb, compact_mode = TRUE, ui_zoom = 1.25,
                        panel_order = $2 WHERE id = $3`,
      [JSON.stringify({ 'nexum.toolbar.order': ['map', 'stats'], 'nexum.sidebar.side': 'right' }),
       ['signatures', 'notes'], admin],
    );
    // No body: the server reads the caller's row for itself.
    const { body } = await request(appFor(admin, CORP)).put('/api/admin/ui-defaults').expect(200);
    expect(body.scope).toBe('corp');
    expect(body.settings['nexum.toolbar.order']).toEqual(['map', 'stats']);
    expect(body.prefs.compactMode).toBe(true);
    expect(body.prefs.uiZoom).toBe(1.25);
    expect(body.prefs.panelOrder).toEqual(['signatures', 'notes']);
  });

  it('never captures the jump skills, which are one pilot own', async () => {
    // Presented as everyone's default these would give the rest of the org
    // wrong range and fuel figures -- worse than having no default.
    await db.query(`UPDATE users SET ui_settings = $1::jsonb WHERE id = $2`, [JSON.stringify({
      'nexum.jump.jdc': 5, 'nexum.jump.jf': 4, 'nexum.jump.planShip': 'Anshar',
      'nexum.presence.hidden': true, 'nexum.watchlist': ['someone'],
      'nexum.sidebar.side': 'right',
    }), admin]);
    const { body } = await request(appFor(admin, CORP)).put('/api/admin/ui-defaults').expect(200);

    // Control: something WAS captured, so the absences below mean the filter
    // ran rather than the capture having failed.
    expect(body.settings['nexum.sidebar.side']).toBe('right');
    for (const k of ['nexum.jump.jdc', 'nexum.jump.jf', 'nexum.jump.planShip',
                     'nexum.presence.hidden', 'nexum.watchlist']) {
      expect(body.settings[k], k).toBeUndefined();
    }
  });

  it('never captures a key that does not sync at all', async () => {
    await db.query(`UPDATE users SET ui_settings = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ 'nexum.notARealSetting': 1, 'nexum.sidebar.side': 'left' }), admin]);
    const { body } = await request(appFor(admin, CORP)).put('/api/admin/ui-defaults').expect(200);
    expect(body.settings['nexum.sidebar.side']).toBe('left');
    expect(body.settings['nexum.notARealSetting']).toBeUndefined();
  });

  it('keeps one org out of another org defaults', async () => {
    await db.query(`UPDATE users SET ui_settings = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ 'nexum.sidebar.side': 'right' }), admin]);
    await request(appFor(admin, CORP)).put('/api/admin/ui-defaults').expect(200);

    const ours = await request(appFor(admin, CORP)).get('/api/admin/ui-defaults').expect(200);
    expect(ours.body.settings['nexum.sidebar.side']).toBe('right');

    const theirs = await request(appFor(otherAdmin, OTHER_CORP)).get('/api/admin/ui-defaults').expect(200);
    expect(theirs.body.settings).toEqual({});
  });

  it('does not let an ordinary member set the org defaults', async () => {
    await request(appFor(member, CORP)).put('/api/admin/ui-defaults').expect(403);
    const { rows } = await db.query(`SELECT 1 FROM org_ui_defaults`);
    expect(rows).toHaveLength(0);
  });

  it('gives a brand-new account the org column prefs', async () => {
    await db.query(`UPDATE users SET compact_mode = TRUE, ui_zoom = 1.25, panel_order = $1 WHERE id = $2`,
      [['signatures'], admin]);
    await request(appFor(admin, CORP)).put('/api/admin/ui-defaults').expect(200);

    const joiner = await seedUser({ characterId: 9, corpId: CORP, role: 'readonly' });
    await applyPrefsToNewUser(joiner, orgScopeFor(CORP, null));

    const { rows } = await db.query<{ compact_mode: boolean; ui_zoom: string; panel_order: string[] }>(
      `SELECT compact_mode, ui_zoom, panel_order FROM users WHERE id = $1`, [joiner]);
    expect(rows[0].compact_mode).toBe(true);
    expect(Number(rows[0].ui_zoom)).toBe(1.25);
    expect(rows[0].panel_order).toEqual(['signatures']);
  });

  it('does nothing at all when the org has set no defaults', async () => {
    const joiner = await seedUser({ characterId: 10, corpId: CORP, role: 'readonly' });
    await applyPrefsToNewUser(joiner, orgScopeFor(CORP, null));
    const { rows } = await db.query<{ compact_mode: boolean }>(
      `SELECT compact_mode FROM users WHERE id = $1`, [joiner]);
    expect(rows[0].compact_mode).toBe(false);          // the schema default, untouched
  });

  it('clears them', async () => {
    await request(appFor(admin, CORP)).put('/api/admin/ui-defaults').expect(200);
    await request(appFor(admin, CORP)).delete('/api/admin/ui-defaults').expect(200);
    expect(await readDefaults(orgScopeFor(CORP, null))).toMatchObject({ settings: {}, prefs: {} });
  });

  it('records the capture in the audit log', async () => {
    await request(appFor(admin, CORP)).put('/api/admin/ui-defaults').expect(200);
    const { rows } = await db.query(`SELECT 1 FROM admin_audit WHERE action = 'ui_defaults_update'`);
    expect(rows).toHaveLength(1);
  });
});
