import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { encryptToken } from './tokenCrypto.js';
import { SCOPE } from './esiScopes.js';
import { getTokenAndScopes, getValidToken, isScopeMissing } from './eveToken.js';

const dbReady = await ensureIntegrationDb();

const jwt = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

// Give a seeded user a token, live or already expired, and a recorded scope
// list (null = not recorded yet).
async function giveToken(userId: number, opts: { expired?: boolean; scopes: string[] | null }) {
  await db.query(
    `UPDATE users SET access_token = $1, refresh_token = $2, token_expires_at = $3, esi_scopes = $4
     WHERE id = $5`,
    [encryptToken('stored-access'), encryptToken('stored-refresh'),
     new Date(Date.now() + (opts.expired ? -60_000 : 3_600_000)), opts.scopes, userId]);
}

describe.skipIf(!dbReady)('ESI token scope checks (integration)', () => {
  const fetchMock = vi.fn();
  beforeEach(async () => {
    await truncateAll();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a character whose scopes are not recorded yet keeps every feature', async () => {
    const id = await seedUser({ characterId: 9001 });
    await giveToken(id, { scopes: null });
    await expect(getValidToken(id, [SCOPE.fleet, SCOPE.waypoint])).resolves.toBe('stored-access');
  });

  it('a granted scope gets the token', async () => {
    const id = await seedUser({ characterId: 9002 });
    await giveToken(id, { scopes: [SCOPE.location, SCOPE.online] });
    await expect(getValidToken(id, [SCOPE.online, SCOPE.location])).resolves.toBe('stored-access');
  });

  it('a scope never granted is refused before any token refresh or ESI call', async () => {
    const id = await seedUser({ characterId: 9003 });
    await giveToken(id, { expired: true, scopes: [SCOPE.location, SCOPE.online] });
    const err = await getValidToken(id, [SCOPE.location, SCOPE.fleet]).catch((e: unknown) => e);
    expect(isScopeMissing(err)).toBe(true);
    expect((err as { missing: string[] }).missing).toEqual([SCOPE.fleet]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refresh records what the new token holds', async () => {
    const id = await seedUser({ characterId: 9004 });
    await giveToken(id, { expired: true, scopes: null });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: jwt({ scp: [SCOPE.location, SCOPE.online] }), refresh_token: 'r2', expires_in: 1200,
    })));
    const { scopes } = await getTokenAndScopes(id);
    expect(scopes).toEqual([SCOPE.location, SCOPE.online]);
    const { rows } = await db.query(`SELECT esi_scopes FROM users WHERE id = $1`, [id]);
    expect(rows[0].esi_scopes).toEqual([SCOPE.location, SCOPE.online]);
  });

  it('the first refresh that reveals a missing scope refuses it', async () => {
    const id = await seedUser({ characterId: 9005 });
    await giveToken(id, { expired: true, scopes: null });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: jwt({ scp: [SCOPE.location] }), refresh_token: 'r2', expires_in: 1200,
    })));
    const err = await getValidToken(id, [SCOPE.waypoint]).catch((e: unknown) => e);
    expect(isScopeMissing(err)).toBe(true);
  });

  it('a refreshed token it cannot read keeps the recorded list', async () => {
    const id = await seedUser({ characterId: 9006 });
    await giveToken(id, { expired: true, scopes: [SCOPE.location] });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: 'opaque', refresh_token: 'r2', expires_in: 1200,
    })));
    await getTokenAndScopes(id);
    const { rows } = await db.query(`SELECT esi_scopes FROM users WHERE id = $1`, [id]);
    expect(rows[0].esi_scopes).toEqual([SCOPE.location]);
  });
});
