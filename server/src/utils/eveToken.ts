import { db } from '../db.js';
import { decryptToken, encryptToken } from './tokenCrypto.js';
import { missingScopes, scopesFromAccessToken, type EsiScope } from './esiScopes.js';

const CLIENT_ID     = process.env.EVE_CLIENT_ID!;
const CLIENT_SECRET = process.env.EVE_CLIENT_SECRET!;
const EVE_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';

interface TokenRow {
  access_token: string;
  refresh_token: string;
  token_expires_at: Date;
  character_id: number;
  esi_scopes: string[] | null;
}

// The character never granted a scope this call needs. Thrown BEFORE any ESI
// request (or token refresh), so a missing scope costs no ESI error -- they
// count against an error limit the deployment's IP shares.
export class ScopeMissingError extends Error {
  constructor(readonly missing: EsiScope[]) {
    super(`ESI scope not granted: ${missing.join(', ')}`);
    this.name = 'ScopeMissingError';
  }
}

export function isScopeMissing(err: unknown): err is ScopeMissingError {
  return err instanceof ScopeMissingError;
}

// A usable access token for the character, plus the scopes it holds (null when
// not recorded yet, which counts as holding everything -- see esiScopes.ts).
// Refreshes the token when it is about to expire, and records the scopes the
// refreshed token carries.
export async function getTokenAndScopes(
  userId: number,
  required: readonly EsiScope[] = [],
): Promise<{ token: string; scopes: string[] | null }> {
  const { rows } = await db.query<TokenRow>(
    `SELECT access_token, refresh_token, token_expires_at, character_id, esi_scopes
     FROM users WHERE id = $1`,
    [userId],
  );

  if (!rows.length) throw new Error('User not found');
  const row = rows[0];

  const missing = missingScopes(row.esi_scopes, required);
  if (missing.length) throw new ScopeMissingError(missing);

  // Return existing token if still valid (with 60s buffer)
  if (new Date(row.token_expires_at).getTime() - Date.now() > 60_000) {
    return { token: decryptToken(row.access_token), scopes: row.esi_scopes };
  }

  // Refresh the token
  const res = await fetch(EVE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: decryptToken(row.refresh_token),
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);

  const tokens = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const scopes = scopesFromAccessToken(tokens.access_token) ?? row.esi_scopes;

  await db.query(
    `UPDATE users SET access_token = $1, refresh_token = $2, token_expires_at = $3,
            esi_scopes = $5, updated_at = NOW()
     WHERE id = $4`,
    [encryptToken(tokens.access_token), encryptToken(tokens.refresh_token), expiresAt, userId, scopes],
  );

  // The first refresh after this shipped is when an existing character's
  // scopes become known; check again so a scope it turns out to lack isn't used.
  const nowMissing = missingScopes(scopes, required);
  if (nowMissing.length) throw new ScopeMissingError(nowMissing);

  return { token: tokens.access_token, scopes };
}

// A usable access token for the character. Pass the scopes the call needs: if
// the character never granted one, this throws ScopeMissingError without
// touching ESI.
export async function getValidToken(userId: number, required: readonly EsiScope[] = []): Promise<string> {
  return (await getTokenAndScopes(userId, required)).token;
}
