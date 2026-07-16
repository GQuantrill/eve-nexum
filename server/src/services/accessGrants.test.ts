import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config + db so we can drive the install-type / positive-standing decision
// logic without a database. hoisted so the mock factories (which run before the
// module import below) can close over them.
const { mockConfig, queryMock, mockSettings } = vi.hoisted(() => ({
  mockConfig: {
    corpMode: true,
    allianceMode: false,
    corpIds: [98120330] as number[],
    allianceIds: [1354830081] as number[],
  },
  queryMock: vi.fn(),
  mockSettings: { enabled: false, threshold: 10 as 5 | 10 },
}));

vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../db.js', () => ({ db: { query: queryMock } }));
vi.mock('./appSettings.js', () => ({
  getStandingsLoginSettings: async () => ({ enabled: mockSettings.enabled, threshold: mockSettings.threshold }),
}));

// vi.mock calls above are hoisted by vitest, so this static import already sees
// the mocked config/db.
import { isLoginPermitted, standingPermitsTarget, grantKindAllowedForInstall, requiresPositiveStanding, standingsPermitLogin } from './accessGrants.js';

const rows = (ok: boolean) => ({ rows: [{ ok }] });

beforeEach(() => {
  queryMock.mockReset();
  mockConfig.corpMode = true;
  mockConfig.allianceMode = false;
  mockConfig.corpIds = [98120330];
  mockConfig.allianceIds = [1354830081];
  mockSettings.enabled = false;
  mockSettings.threshold = 10;
});

describe('grantKindAllowedForInstall', () => {
  it('corp install: corp, character AND alliance all allowed', () => {
    expect(grantKindAllowedForInstall('corp')).toBe(true);
    expect(grantKindAllowedForInstall('character')).toBe(true);
    expect(grantKindAllowedForInstall('alliance')).toBe(true); // corp can admit an alliance
  });

  it('solo (unrestricted) install: alliance kind not offered', () => {
    mockConfig.corpMode = false;
    mockConfig.allianceMode = false;
    expect(grantKindAllowedForInstall('alliance')).toBe(false);
  });

  it('alliance install: alliance allowed', () => {
    mockConfig.allianceMode = true;
    expect(grantKindAllowedForInstall('alliance')).toBe(true);
    expect(grantKindAllowedForInstall('corp')).toBe(true);
  });
});

describe('requiresPositiveStanding', () => {
  it('gates corp + alliance (group targets)', () => {
    expect(requiresPositiveStanding('corp')).toBe(true);
    expect(requiresPositiveStanding('alliance')).toBe(true);
  });
  it('exempts individual characters (deliberate 1:1 grant)', () => {
    expect(requiresPositiveStanding('character')).toBe(false);
  });
});

describe('standingPermitsTarget', () => {
  it('alliance install reads alliance_standings, corp target -> "corporation" contact', async () => {
    mockConfig.allianceMode = true;
    queryMock.mockResolvedValue(rows(true));
    const ok = await standingPermitsTarget('corp', 98120330);
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('alliance_standings');
    expect(sql).not.toContain('corp_standings');
    expect(params[0]).toEqual(mockConfig.allianceIds); // owner = deployment alliance(s)
    expect(params[1]).toBe('corporation');
    expect(params[2]).toBe(98120330);
  });

  it('alliance install: alliance target -> "alliance" contact_kind', async () => {
    mockConfig.allianceMode = true;
    queryMock.mockResolvedValue(rows(true));
    await standingPermitsTarget('alliance', 1);
    expect((queryMock.mock.calls[0][1] as unknown[])[1]).toBe('alliance');
  });

  it('alliance install: character target -> "character" contact_kind', async () => {
    mockConfig.allianceMode = true;
    queryMock.mockResolvedValue(rows(true));
    await standingPermitsTarget('character', 1);
    expect((queryMock.mock.calls[0][1] as unknown[])[1]).toBe('character');
  });

  it('corp install reads corp_standings, NOT alliance_standings', async () => {
    queryMock.mockResolvedValue(rows(true));
    const ok = await standingPermitsTarget('corp', 98120330);
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('corp_standings');
    expect(sql).not.toContain('alliance_standings');
    expect(params[0]).toEqual(mockConfig.corpIds);
    expect(params[1]).toBe('corporation');
  });

  it('corp install: an alliance target checks corp_standings on the alliance contact', async () => {
    queryMock.mockResolvedValue(rows(true));
    const ok = await standingPermitsTarget('alliance', 1354830081);
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('corp_standings');
    expect(sql).not.toContain('alliance_standings');
    expect(params[1]).toBe('alliance');   // corp's contact toward the alliance
    expect(params[2]).toBe(1354830081);
  });

  it('fail-closed: a non-positive / missing standing denies', async () => {
    queryMock.mockResolvedValue(rows(false));
    expect(await standingPermitsTarget('corp', 999)).toBe(false);
  });

  it('fail-closed: an empty result set denies', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await standingPermitsTarget('corp', 999)).toBe(false);
  });
});

describe('standingsPermitLogin', () => {
  const pilot = { characterId: 1841929906, corpId: 98370861, allianceId: 99000001 };

  it('returns false (without querying) when the toggle is off', async () => {
    mockSettings.enabled = false;
    expect(await standingsPermitLogin(pilot)).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('alliance install: reads alliance_standings with the threshold + all three contact kinds', async () => {
    mockConfig.allianceMode = true;
    mockSettings.enabled = true;
    mockSettings.threshold = 10;
    queryMock.mockResolvedValue({ rows: [{ ok: true }] });
    expect(await standingsPermitLogin(pilot)).toBe(true);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('alliance_standings');
    expect(sql).not.toContain('corp_standings');
    expect(params[0]).toEqual(mockConfig.allianceIds);
    expect(params[1]).toBe(10);                 // threshold
    expect(params[2]).toBe(pilot.allianceId);   // alliance match
    expect(params[3]).toBe(pilot.corpId);       // corp match
    expect(params[4]).toBe(pilot.characterId);  // character match
  });

  it('corp install: reads corp_standings, matching corp, character AND alliance', async () => {
    mockSettings.enabled = true;
    mockSettings.threshold = 5;
    queryMock.mockResolvedValue({ rows: [{ ok: false }] });
    expect(await standingsPermitLogin(pilot)).toBe(false);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('corp_standings');
    expect(sql).not.toContain('alliance_standings');
    expect(params[0]).toEqual(mockConfig.corpIds);
    expect(params[1]).toBe(5);
    expect(params[2]).toBe(pilot.corpId);
    expect(params[3]).toBe(pilot.characterId);
    expect(params[4]).toBe(pilot.allianceId); // corp can admit the pilot's alliance
  });

  it('fail-closed: an empty result set denies', async () => {
    mockSettings.enabled = true;
    queryMock.mockResolvedValue({ rows: [] });
    expect(await standingsPermitLogin(pilot)).toBe(false);
  });
});

describe('isLoginPermitted', () => {
  it('admits when a grant matches', async () => {
    queryMock.mockResolvedValue(rows(true));
    expect(await isLoginPermitted({ characterId: 1, corpId: 2, allianceId: 3 })).toBe(true);
  });

  it('rejects when no grant matches', async () => {
    queryMock.mockResolvedValue(rows(false));
    expect(await isLoginPermitted({ characterId: 1, corpId: 2, allianceId: 3 })).toBe(false);
  });

  it('passes character/corp/alliance ids through as the gate parameters', async () => {
    queryMock.mockResolvedValue(rows(true));
    await isLoginPermitted({ characterId: 11, corpId: 22, allianceId: 33 });
    expect(queryMock.mock.calls[0][1]).toEqual([11, 22, 33]);
  });

  it('rejects (empty result) rather than throwing when the row is absent', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await isLoginPermitted({ characterId: 1, corpId: null, allianceId: null })).toBe(false);
  });
});
