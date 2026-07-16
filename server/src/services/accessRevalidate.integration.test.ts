import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock ONLY config (real db). Proxy over the real config with a live-mutable
// override so tests can flip restrictedMode / adminCharId / install type.
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser, seedSession, liveSessionCount } from '../test/integrationDb.js';
import { db } from '../db.js';
import { setSetting } from './appSettings.js';
import { revalidateActiveSessions } from './accessRevalidate.js';

const dbReady = await ensureIntegrationDb();

const grantCorp = (corpId: number) =>
  db.query(`INSERT INTO access_grants (id, kind, eve_id, source, created_at) VALUES (gen_random_uuid(), 'corp', $1, 'admin', NOW())`, [corpId]);

describe.skipIf(!dbReady)('revalidateActiveSessions (integration — real SQL)', () => {
  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, allianceMode: false, corpIds: [1000], allianceIds: [2000], restrictedMode: true, adminCharId: 777 };
  });

  it('keeps a still-permitted user, evicts one no longer permitted', async () => {
    await grantCorp(500);
    const ok  = await seedUser({ characterId: 1, corpId: 500 });   // permitted by grant
    const bad = await seedUser({ characterId: 2, corpId: 999 });   // no grant, no standing
    await seedSession(ok);
    await seedSession(bad);

    const res = await revalidateActiveSessions();

    expect(res.usersEvicted).toBe(1);
    expect(res.sessionsKilled).toBe(1);
    expect(await liveSessionCount(ok)).toBe(1);
    expect(await liveSessionCount(bad)).toBe(0);
  });

  it('kills every live session of an evicted user', async () => {
    const bad = await seedUser({ characterId: 2, corpId: 999 });
    await seedSession(bad);
    await seedSession(bad);
    const res = await revalidateActiveSessions();
    expect(res.usersEvicted).toBe(1);
    expect(res.sessionsKilled).toBe(2);
    expect(await liveSessionCount(bad)).toBe(0);
  });

  it('never evicts the bootstrap admin, even with no grant', async () => {
    const admin = await seedUser({ characterId: 777, corpId: 999, role: 'admin' });
    await seedSession(admin);
    const res = await revalidateActiveSessions();
    expect(res.sessionsKilled).toBe(0);
    expect(await liveSessionCount(admin)).toBe(1);
  });

  it('evicts a blocked user even when a grant would otherwise permit them', async () => {
    await grantCorp(500);
    const u = await seedUser({ characterId: 3, corpId: 500, blocked: true });
    await seedSession(u);
    const res = await revalidateActiveSessions();
    expect(res.sessionsKilled).toBe(1);
    expect(await liveSessionCount(u)).toBe(0);
  });

  it('is a no-op in solo (unrestricted) mode', async () => {
    state.over = { ...state.over, restrictedMode: false };
    const u = await seedUser({ characterId: 4, corpId: 999 });
    await seedSession(u);
    const res = await revalidateActiveSessions();
    expect(res).toEqual({ usersEvicted: 0, sessionsKilled: 0 });
    expect(await liveSessionCount(u)).toBe(1);
  });

  it('ignores expired sessions (only live sessions are scanned)', async () => {
    const u = await seedUser({ characterId: 5, corpId: 999 }); // not permitted
    await seedSession(u, { expired: true });
    const res = await revalidateActiveSessions();
    expect(res.sessionsKilled).toBe(0);
    // The expired row is left untouched (the scan never reached this user).
    expect(await liveSessionCount(u)).toBe(1);
  });

  it('keeps a user admitted purely by the standings auto-admit', async () => {
    await setSetting('standings_login_enabled', 'true', null);
    await setSetting('standings_login_threshold', '5', null);
    await db.query(`INSERT INTO corp_standings (corp_id, contact_kind, contact_id, standing, updated_at) VALUES (1000, 'corporation', 600, 10, NOW())`);
    const u = await seedUser({ characterId: 6, corpId: 600 }); // no grant, but +10 standing
    await seedSession(u);
    const res = await revalidateActiveSessions();
    expect(res.sessionsKilled).toBe(0);
    expect(await liveSessionCount(u)).toBe(1);
  });
});
