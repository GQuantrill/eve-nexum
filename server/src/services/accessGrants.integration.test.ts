import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock ONLY config (to drive install-type) — the db is real. A Proxy over the
// real config lets each test flip corpMode/allianceMode/ids live (services read
// config.* at call time) while everything else keeps its real value.
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll } from '../test/integrationDb.js';
import { db } from '../db.js';
import { setSetting } from './appSettings.js';
import { isLoginPermitted, standingPermitsTarget, standingsPermitLogin } from './accessGrants.js';

const dbReady = await ensureIntegrationDb();

const grant = (kind: string, eveId: number, source = 'admin') =>
  db.query(
    `INSERT INTO access_grants (id, kind, eve_id, source, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, NOW())`,
    [kind, eveId, source],
  );

const corpStanding = (contactKind: string, contactId: number, standing: number, corpId = 1000) =>
  db.query(
    `INSERT INTO corp_standings (corp_id, contact_kind, contact_id, standing, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [corpId, contactKind, contactId, standing],
  );

const allianceStanding = (contactKind: string, contactId: number, standing: number, allianceId = 2000) =>
  db.query(
    `INSERT INTO alliance_standings (alliance_id, contact_kind, contact_id, standing, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [allianceId, contactKind, contactId, standing],
  );

describe.skipIf(!dbReady)('accessGrants (integration — real SQL)', () => {
  beforeEach(async () => {
    await truncateAll();
    // Default: a corp installation.
    state.over = { corpMode: true, allianceMode: false, corpIds: [1000], allianceIds: [2000], restrictedMode: true, adminCharId: null };
  });

  describe('isLoginPermitted', () => {
    it('admits a character whose corp has a grant', async () => {
      await grant('corp', 500);
      expect(await isLoginPermitted({ characterId: 9, corpId: 500, allianceId: null })).toBe(true);
    });

    it('rejects when no grant matches', async () => {
      await grant('corp', 500);
      expect(await isLoginPermitted({ characterId: 9, corpId: 999, allianceId: null })).toBe(false);
    });

    it('matches on alliance-kind and character-kind grants', async () => {
      await grant('alliance', 3000);
      await grant('character', 42);
      expect(await isLoginPermitted({ characterId: 1, corpId: 1, allianceId: 3000 })).toBe(true);
      expect(await isLoginPermitted({ characterId: 42, corpId: 1, allianceId: 1 })).toBe(true);
    });

    it('does not match a corp grant against a null corp id', async () => {
      await grant('corp', 500);
      expect(await isLoginPermitted({ characterId: 9, corpId: null, allianceId: null })).toBe(false);
    });
  });

  describe('standingPermitsTarget — corp installation', () => {
    it('positive corp standing permits; zero and negative deny', async () => {
      await corpStanding('corporation', 700, 5);
      await corpStanding('corporation', 701, 0);
      await corpStanding('corporation', 702, -10);
      expect(await standingPermitsTarget('corp', 700)).toBe(true);
      expect(await standingPermitsTarget('corp', 701)).toBe(false);
      expect(await standingPermitsTarget('corp', 702)).toBe(false);
    });

    it('fails closed when there is no standing row', async () => {
      expect(await standingPermitsTarget('corp', 999)).toBe(false);
    });

    it('an alliance target checks the corp\'s own alliance contact', async () => {
      await allianceStanding('corporation', 800, 10); // in alliance_standings — must be ignored
      await corpStanding('alliance', 3000, 7);
      expect(await standingPermitsTarget('alliance', 3000)).toBe(true);
      expect(await standingPermitsTarget('alliance', 3001)).toBe(false);
    });

    it('never admits a negative standing via any magnitude/abs path', async () => {
      await corpStanding('corporation', 703, -10);
      expect(await standingPermitsTarget('corp', 703)).toBe(false);
    });
  });

  describe('standingPermitsTarget — alliance installation', () => {
    beforeEach(() => { state.over = { ...state.over, corpMode: false, allianceMode: true }; });

    it('reads alliance_standings and ignores corp_standings', async () => {
      await allianceStanding('corporation', 800, 5);
      await corpStanding('corporation', 801, 10); // must be ignored on an alliance install
      expect(await standingPermitsTarget('corp', 800)).toBe(true);
      expect(await standingPermitsTarget('corp', 801)).toBe(false);
    });
  });

  describe('standingsPermitLogin (auto-admit)', () => {
    it('returns false when the toggle is off (no app_settings rows)', async () => {
      expect(await standingsPermitLogin({ characterId: 1, corpId: 1000, allianceId: 2000 })).toBe(false);
    });

    it('corp install: admits at/above threshold, denies below; alliance of pilot also matches', async () => {
      await setSetting('standings_login_enabled', 'true', null);
      await setSetting('standings_login_threshold', '5', null);
      await corpStanding('corporation', 600, 5);   // friendly corp at exactly 5
      await corpStanding('corporation', 601, 0);   // neutral
      await corpStanding('alliance', 3000, 10);    // corp holds a friendly alliance
      // pilot in the friendly corp
      expect(await standingsPermitLogin({ characterId: 1, corpId: 600, allianceId: 9 })).toBe(true);
      // pilot in the neutral corp
      expect(await standingsPermitLogin({ characterId: 1, corpId: 601, allianceId: 9 })).toBe(false);
      // pilot whose ALLIANCE the corp stands friendly (corp-admits-alliance)
      expect(await standingsPermitLogin({ characterId: 1, corpId: 999, allianceId: 3000 })).toBe(true);
    });

    it('threshold 10 denies a +5 pilot that threshold 5 would admit', async () => {
      await corpStanding('corporation', 600, 5);
      await setSetting('standings_login_enabled', 'true', null);
      await setSetting('standings_login_threshold', '10', null);
      expect(await standingsPermitLogin({ characterId: 1, corpId: 600, allianceId: null })).toBe(false);
      await setSetting('standings_login_threshold', '5', null);
      expect(await standingsPermitLogin({ characterId: 1, corpId: 600, allianceId: null })).toBe(true);
    });

    it('a negative-standing pilot is denied at both thresholds', async () => {
      await corpStanding('corporation', 610, -10);
      await setSetting('standings_login_enabled', 'true', null);
      for (const th of ['5', '10']) {
        await setSetting('standings_login_threshold', th, null);
        expect(await standingsPermitLogin({ characterId: 1, corpId: 610, allianceId: null })).toBe(false);
      }
    });
  });
});
