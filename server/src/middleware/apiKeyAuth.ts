import type { Request, Response, NextFunction } from 'express';
import { db } from '../db.js';
import { hashApiKey } from '../utils/apiKeys.js';
import type { Role, ApiScope } from './authContext.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('apiKeyAuth');

// Throttle the last_used_at write so a chatty client doesn't cause a row write
// per request — once a minute per key is plenty to spot a stale/leaked key.
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWrittenAt = new Map<string, number>();

// Resolve an `Authorization: Bearer <key>` into req.apiAuth. If no Bearer
// header is present this is a no-op (next()) so the route's own requireAuth /
// session auth still applies — routes can accept either credential. A present
// but invalid/expired/inert key is a hard 401.
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) { next(); return; }

  const raw = header.slice(7).trim();
  if (!raw) { res.status(401).json({ error: 'Invalid API key' }); return; }

  try {
    const { rows } = await db.query<{
      id: string; ownerId: number; contextUserId: number | null;
      scope: string; expiresAt: Date | null;
      role: Role | null; corpId: number | null; allianceId: number | null; characterId: number | null; characterName: string | null;
    }>(
      `SELECT t.id,
              t.owner_id          AS "ownerId",
              t.context_user_id   AS "contextUserId",
              t.scope,
              t.expires_at        AS "expiresAt",
              u.role,
              u.corp_id           AS "corpId",
              u.alliance_id       AS "allianceId",
              u.character_id      AS "characterId",
              u.character_name    AS "characterName"
         FROM api_tokens t
         LEFT JOIN users u ON u.id = t.context_user_id
        WHERE t.token_hash = $1`,
      [hashApiKey(raw)],
    );

    const row = rows[0];
    if (!row) { res.status(401).json({ error: 'Invalid API key' }); return; }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      res.status(401).json({ error: 'API key expired' }); return;
    }
    // Bound character removed from the account → key is inert (not silently
    // headless). The owner rebinds or revokes it from the key list.
    if (row.contextUserId == null || row.role == null || row.characterId == null) {
      res.status(401).json({ error: 'API key is inactive (bound character removed)' }); return;
    }

    const scope: ApiScope = row.scope === 'write' ? 'write' : row.scope === 'events' ? 'events' : 'read';
    req.apiAuth = {
      userId:        row.contextUserId,
      characterId:   row.characterId,
      characterName: row.characterName,
      ownerId:       row.ownerId,
      role:          row.role,
      corpId:        row.corpId,
      allianceId:    row.allianceId,
      apiScope:      scope,
    };

    // Best-effort, throttled last_used_at bump — never blocks the request.
    const now = Date.now();
    const prev = lastUsedWrittenAt.get(row.id) ?? 0;
    if (now - prev >= LAST_USED_THROTTLE_MS) {
      lastUsedWrittenAt.set(row.id, now);
      db.query(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [row.id])
        .catch((err) => log.warn(`failed to bump last_used_at for key ${row.id}: ${err}`));
    }

    next();
  } catch (err) {
    log.error(`api key auth failed: ${err}`);
    res.status(500).json({ error: 'Authentication error' });
  }
}
