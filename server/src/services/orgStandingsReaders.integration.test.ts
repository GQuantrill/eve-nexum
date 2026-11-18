import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock ONLY config (to drive install type); the db is real.
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { SCOPE } from '../utils/esiScopes.js';
import { orgStandingsReaders } from './accessGrants.js';

const dbReady = await ensureIntegrationDb();

const CORP = 98_100_001, OTHER_CORP = 98_100_002, ALLIANCE = 99_100_001;
let n = 2_200_000_000;
const pilot = async (o: { corp?: number; alliance?: number; scopes: string[] | null; blocked?: boolean }) => {
  const id = await seedUser({ characterId: ++n, corpId: o.corp ?? null, allianceId: o.alliance ?? null, blocked: o.blocked });
  await db.query(`UPDATE users SET esi_scopes = $1 WHERE id = $2`, [o.scopes, id]);
  return id;
};

describe.skipIf(!dbReady)('orgStandingsReaders (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, allianceMode: false, corpIds: [CORP], allianceIds: [] };
  });

  it('corp install: zero when no member has allowed corp contacts', async () => {
    await pilot({ corp: CORP, scopes: [SCOPE.location, SCOPE.online, SCOPE.allianceContacts] });
    expect(await orgStandingsReaders()).toBe(0);
  });

  it('corp install: counts members who allowed it, and unrecorded scopes as allowed', async () => {
    await pilot({ corp: CORP, scopes: [SCOPE.location, SCOPE.corpContacts] });
    await pilot({ corp: CORP, scopes: null });
    expect(await orgStandingsReaders()).toBe(2);
  });

  it('corp install: ignores other corps and blocked members', async () => {
    await pilot({ corp: OTHER_CORP, scopes: [SCOPE.corpContacts] });
    await pilot({ corp: CORP, scopes: [SCOPE.corpContacts], blocked: true });
    expect(await orgStandingsReaders()).toBe(0);
  });

  it('alliance install: needs alliance contacts from an alliance member', async () => {
    state.over = { corpMode: false, allianceMode: true, corpIds: [], allianceIds: [ALLIANCE] };
    await pilot({ corp: CORP, alliance: ALLIANCE, scopes: [SCOPE.corpContacts] });
    expect(await orgStandingsReaders()).toBe(0);
    await pilot({ corp: OTHER_CORP, alliance: ALLIANCE, scopes: [SCOPE.allianceContacts] });
    expect(await orgStandingsReaders()).toBe(1);
  });

  it('solo install: zero (there is no org list)', async () => {
    state.over = { corpMode: false, allianceMode: false, corpIds: [], allianceIds: [] };
    expect(await orgStandingsReaders()).toBe(0);
  });
});
