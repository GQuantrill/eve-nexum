import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config + db so we can drive the install-type / positive-standing decision
// logic without a database. hoisted so the mock factories (which run before the
// module import below) can close over them.
const { mockConfig, queryMock } = vi.hoisted(() => ({
  mockConfig: {
    corpMode: true,
    allianceMode: false,
    corpIds: [98120330] as number[],
    allianceIds: [1354830081] as number[],
  },
  queryMock: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../db.js', () => ({ db: { query: queryMock } }));

// vi.mock calls above are hoisted by vitest, so this static import already sees
// the mocked config/db.
import { isLoginPermitted, standingPermitsTarget, grantKindAllowedForInstall, requiresPositiveStanding } from './accessGrants.js';

const rows = (ok: boolean) => ({ rows: [{ ok }] });

beforeEach(() => {
  queryMock.mockReset();
  mockConfig.corpMode = true;
  mockConfig.allianceMode = false;
  mockConfig.corpIds = [98120330];
  mockConfig.allianceIds = [1354830081];
});

describe('grantKindAllowedForInstall', () => {
  it('corp install: corp + character allowed, alliance NOT (alliance-install-only)', () => {
    expect(grantKindAllowedForInstall('corp')).toBe(true);
    expect(grantKindAllowedForInstall('character')).toBe(true);
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

  it('corp install: an alliance target is refused WITHOUT querying (alliance-install-only)', async () => {
    const ok = await standingPermitsTarget('alliance', 1354830081);
    expect(ok).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
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
