import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

// Mock config (real db) so we can flip restricted mode / grace period / admin.
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { setSetting } from './appSettings.js';
import { expireIdleOrgMaps, expireOrphanPersonalMaps } from './mapCleanup.js';

const dbReady = await ensureIntegrationDb();

const DAY = 86_400_000;
// A personal map for `userId`, last touched `ageDays` ago.
async function seedPersonalMap(userId: number, ageDays: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO maps (id, user_id, name, last_active_at) VALUES ($1, $2, 'P', NOW() - ($3 || ' days')::interval)`,
    [id, userId, String(ageDays)]);
  return id;
}
async function seedCorpMap(userId: number, corpId: number, ageDays: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO maps (id, user_id, name, corp_id, last_active_at) VALUES ($1, $2, 'C', $3, NOW() - ($4 || ' days')::interval)`,
    [id, userId, corpId, String(ageDays)]);
  return id;
}
const grantCorp = (corpId: number) =>
  db.query(`INSERT INTO access_grants (id, kind, eve_id, source, created_at) VALUES (gen_random_uuid(), 'corp', $1, 'admin', NOW())`, [corpId]);
const mapExists = async (id: string): Promise<boolean> =>
  (await db.query(`SELECT 1 FROM maps WHERE id = $1`, [id])).rows.length > 0;

describe.skipIf(!dbReady)('map cleanup (integration — real SQL)', () => {
  beforeEach(async () => {
    await truncateAll();
    // corp install, admitted corp 1000, 30-day grace, bootstrap admin char 777.
    state.over = { corpMode: true, allianceMode: false, corpIds: [1000], allianceIds: [], restrictedMode: true, adminCharId: 777, corpMapExpireDays: 30 };
  });

  describe('expireOrphanPersonalMaps', () => {
    it('removes an idle personal map whose owner can no longer log in', async () => {
      // Owner in corp 999 — not admitted (no grant, no standing).
      const u = await seedUser({ characterId: 1, corpId: 999 });
      const m = await seedPersonalMap(u, 40); // idle 40d > 30d grace
      const removed = await expireOrphanPersonalMaps();
      expect(removed).toBe(1);
      expect(await mapExists(m)).toBe(false);
    });

    it('keeps an idle personal map whose owner is STILL permitted (active account)', async () => {
      await grantCorp(1000);
      const u = await seedUser({ characterId: 2, corpId: 1000 }); // admitted by grant
      const m = await seedPersonalMap(u, 90);                     // very idle, but owner is fine
      const removed = await expireOrphanPersonalMaps();
      expect(removed).toBe(0);
      expect(await mapExists(m)).toBe(true);
    });

    it('keeps a recently-active orphan map (inside the idle grace)', async () => {
      const u = await seedUser({ characterId: 3, corpId: 999 }); // not permitted...
      const m = await seedPersonalMap(u, 10);                    // ...but touched 10d ago (< 30d)
      const removed = await expireOrphanPersonalMaps();
      expect(removed).toBe(0);
      expect(await mapExists(m)).toBe(true);
    });

    it('keeps a map whose owner is admitted purely by standings', async () => {
      await setSetting('standings_login_enabled', 'true', null);
      await setSetting('standings_login_threshold', '5', null);
      await db.query(`INSERT INTO corp_standings (corp_id, contact_kind, contact_id, standing, updated_at) VALUES (1000, 'corporation', 600, 10, NOW())`);
      const u = await seedUser({ characterId: 4, corpId: 600 }); // +10 standing, no grant
      const m = await seedPersonalMap(u, 60);
      const removed = await expireOrphanPersonalMaps();
      expect(removed).toBe(0);
      expect(await mapExists(m)).toBe(true);
    });

    it('removes a blocked owner’s idle map even if their corp would be admitted', async () => {
      await grantCorp(1000);
      const u = await seedUser({ characterId: 5, corpId: 1000, blocked: true });
      const m = await seedPersonalMap(u, 40);
      const removed = await expireOrphanPersonalMaps();
      expect(removed).toBe(1);
      expect(await mapExists(m)).toBe(false);
    });

    it('keeps a multi-alt account’s map when ONE alt is still permitted', async () => {
      // Two characters share one owners account; the gone alt created the map,
      // the other alt is still in an admitted corp.
      await grantCorp(1000);
      const { rows } = await db.query<{ id: number }>(`INSERT INTO owners DEFAULT VALUES RETURNING id`);
      const acct = rows[0].id;
      const gone = await seedUser({ characterId: 6, corpId: 999 });  // not permitted
      const live = await seedUser({ characterId: 7, corpId: 1000 }); // permitted
      await db.query(`UPDATE users SET owner_id = $1 WHERE id = ANY($2::int[])`, [acct, [gone, live]]);
      await db.query(`UPDATE maps SET owner_id = $1 WHERE user_id = $2`, [acct, gone]);
      const m = await seedPersonalMap(gone, 50);
      await db.query(`UPDATE maps SET owner_id = $1 WHERE id = $2`, [acct, m]);
      const removed = await expireOrphanPersonalMaps();
      expect(removed).toBe(0);
      expect(await mapExists(m)).toBe(true);
    });

    it('never removes the bootstrap admin’s map', async () => {
      const u = await seedUser({ characterId: 777, corpId: 999, role: 'admin' }); // adminCharId, not otherwise permitted
      const m = await seedPersonalMap(u, 120);
      const removed = await expireOrphanPersonalMaps();
      expect(removed).toBe(0);
      expect(await mapExists(m)).toBe(true);
    });

    it('never touches corp/alliance maps (that is the other sweep)', async () => {
      const u = await seedUser({ characterId: 8, corpId: 999 });
      const cm = await seedCorpMap(u, 999, 90);
      const removed = await expireOrphanPersonalMaps();
      expect(removed).toBe(0);
      expect(await mapExists(cm)).toBe(true);
    });

    it('is a no-op in solo (unrestricted) mode', async () => {
      state.over = { ...state.over, restrictedMode: false };
      const u = await seedUser({ characterId: 9, corpId: 999 });
      const m = await seedPersonalMap(u, 200);
      const removed = await expireOrphanPersonalMaps();
      expect(removed).toBe(0);
      expect(await mapExists(m)).toBe(true);
    });
  });

  describe('expireIdleOrgMaps', () => {
    it('deletes an idle corp map but leaves an idle personal map', async () => {
      const u = await seedUser({ characterId: 10, corpId: 1000 });
      const corp = await seedCorpMap(u, 1000, 40);
      const personal = await seedPersonalMap(u, 40);
      const removed = await expireIdleOrgMaps();
      expect(removed).toBe(1);
      expect(await mapExists(corp)).toBe(false);
      expect(await mapExists(personal)).toBe(true); // untouched by the org sweep
    });

    it('keeps a corp map still within the grace window', async () => {
      const u = await seedUser({ characterId: 11, corpId: 1000 });
      const corp = await seedCorpMap(u, 1000, 10);
      const removed = await expireIdleOrgMaps();
      expect(removed).toBe(0);
      expect(await mapExists(corp)).toBe(true);
    });
  });
});
