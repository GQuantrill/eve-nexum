import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Row { id: number; characterId: number; corpId: number | null; allianceId: number | null; blocked: boolean }

const H = vi.hoisted(() => ({
  config: { restrictedMode: true, adminCharId: 999 as number | null, accessRevalidateMinutes: 60 },
  rows: [] as Row[],
  queryMock: vi.fn(async () => ({ rows: [] as Row[] })),
  isLoginPermitted: vi.fn(async (_p: unknown) => false),
  standingsPermitLogin: vi.fn(async (_p: unknown) => false),
  invalidate: vi.fn(async (_id: number) => 1),
}));

vi.mock('../config.js', () => ({ config: H.config }));
vi.mock('../db.js', () => ({ db: { query: H.queryMock } }));
vi.mock('./accessGrants.js', () => ({
  isLoginPermitted: H.isLoginPermitted,
  standingsPermitLogin: H.standingsPermitLogin,
}));
vi.mock('../utils/sessionInvalidate.js', () => ({ invalidateSessionsForUser: H.invalidate }));

import { revalidateActiveSessions } from './accessRevalidate.js';

beforeEach(() => {
  H.config.restrictedMode = true;
  H.config.adminCharId = 999;
  H.rows = [];
  H.queryMock.mockReset().mockImplementation(async () => ({ rows: H.rows }));
  H.isLoginPermitted.mockReset().mockResolvedValue(false);
  H.standingsPermitLogin.mockReset().mockResolvedValue(false);
  H.invalidate.mockReset().mockResolvedValue(1);
});

const row = (o: Partial<Row> & { id: number; characterId: number }): Row =>
  ({ corpId: null, allianceId: null, blocked: false, ...o });

describe('revalidateActiveSessions', () => {
  it('no-op in a solo (unrestricted) deployment', async () => {
    H.config.restrictedMode = false;
    const r = await revalidateActiveSessions();
    expect(r).toEqual({ usersEvicted: 0, sessionsKilled: 0 });
    expect(H.queryMock).not.toHaveBeenCalled();
    expect(H.invalidate).not.toHaveBeenCalled();
  });

  it('keeps still-permitted users, evicts the rest', async () => {
    H.rows = [row({ id: 1, characterId: 11 }), row({ id: 2, characterId: 12 })];
    H.isLoginPermitted.mockImplementation(async (p: unknown) => (p as { characterId: number }).characterId === 11);
    const r = await revalidateActiveSessions();
    expect(H.invalidate).toHaveBeenCalledTimes(1);
    expect(H.invalidate).toHaveBeenCalledWith(2);
    expect(r).toEqual({ usersEvicted: 1, sessionsKilled: 1 });
  });

  it('admits via the standings path too (not just explicit grants)', async () => {
    H.rows = [row({ id: 7, characterId: 70 })];
    H.isLoginPermitted.mockResolvedValue(false);
    H.standingsPermitLogin.mockResolvedValue(true);
    await revalidateActiveSessions();
    expect(H.invalidate).not.toHaveBeenCalled();
  });

  it('never evicts the configured bootstrap admin', async () => {
    H.rows = [row({ id: 5, characterId: 999 })]; // == adminCharId, and not otherwise permitted
    const r = await revalidateActiveSessions();
    expect(H.invalidate).not.toHaveBeenCalled();
    expect(r.sessionsKilled).toBe(0);
  });

  it('evicts a blocked user even when the gate would otherwise permit them', async () => {
    H.rows = [row({ id: 3, characterId: 13, blocked: true })];
    H.isLoginPermitted.mockResolvedValue(true);
    await revalidateActiveSessions();
    expect(H.invalidate).toHaveBeenCalledWith(3);
  });
});
