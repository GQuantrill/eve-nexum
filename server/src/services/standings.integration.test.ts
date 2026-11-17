import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { config } from '../config.js';
import { SCOPE } from '../utils/esiScopes.js';
import { refreshStandingsForUser, loadOrgContacts } from './standings.js';

const dbReady = await ensureIntegrationDb();

// A corp and alliance that are NOT the deployment's configured ones.
const CORP = 98_765_432, ALLIANCE = 99_887_766, CHAR = 2_100_000_001;
const HOSTILE_CORP = 98_000_001, BLUE_ALLIANCE = 99_000_001;

// Answers ESI's contacts endpoints: one hostile corp on the corp list, one blue
// alliance on the alliance list, nothing personal.
function esiContacts(url: string): Response {
  if (url.includes(`/corporations/${CORP}/contacts/`)) {
    return new Response(JSON.stringify([{ contact_id: HOSTILE_CORP, contact_type: 'corporation', standing: -10 }]));
  }
  if (url.includes(`/alliances/${ALLIANCE}/contacts/`)) {
    return new Response(JSON.stringify([{ contact_id: BLUE_ALLIANCE, contact_type: 'alliance', standing: 10 }]));
  }
  if (url.includes(`/characters/${CHAR}/contacts/`)) return new Response('[]');
  return new Response('not found', { status: 404 });
}

describe.skipIf(!dbReady)('corp and alliance standings refresh (integration)', () => {
  const fetchMock = vi.fn(async (url: string | URL) => esiContacts(String(url)));
  beforeEach(async () => {
    await truncateAll();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const calledFor = (part: string) => fetchMock.mock.calls.some(([u]) => String(u).includes(part));

  it('any pilot fills in their OWN corp and alliance lists, configured or not', async () => {
    expect(config.corpIds).not.toContain(CORP);
    expect(config.allianceIds).not.toContain(ALLIANCE);
    const userId = await seedUser({ characterId: CHAR, corpId: CORP, allianceId: ALLIANCE });

    await refreshStandingsForUser({
      userId, characterId: CHAR, corpId: CORP, allianceId: ALLIANCE, accessToken: 't', scopes: null,
    });

    expect(await loadOrgContacts('corp', CORP)).toEqual([
      expect.objectContaining({ contact_id: HOSTILE_CORP, standing: -10 }),
    ]);
    expect(await loadOrgContacts('alliance', ALLIANCE)).toEqual([
      expect.objectContaining({ contact_id: BLUE_ALLIANCE, standing: 10 }),
    ]);
  });

  it('a list the pilot did not grant is never asked for', async () => {
    const userId = await seedUser({ characterId: CHAR, corpId: CORP, allianceId: ALLIANCE });

    await refreshStandingsForUser({
      userId, characterId: CHAR, corpId: CORP, allianceId: ALLIANCE, accessToken: 't',
      scopes: [SCOPE.location, SCOPE.online, SCOPE.charContacts],
    });

    expect(calledFor(`/characters/${CHAR}/contacts/`)).toBe(true);
    expect(calledFor('/corporations/')).toBe(false);
    expect(calledFor('/alliances/')).toBe(false);
  });

  it('an org-only sync leaves personal contacts alone', async () => {
    const userId = await seedUser({ characterId: CHAR, corpId: CORP, allianceId: ALLIANCE });

    await refreshStandingsForUser({
      userId, characterId: CHAR, corpId: CORP, allianceId: ALLIANCE, accessToken: 't', scopes: null, scope: 'org',
    });

    expect(calledFor('/characters/')).toBe(false);
    expect(calledFor(`/corporations/${CORP}/contacts/`)).toBe(true);
  });
});
