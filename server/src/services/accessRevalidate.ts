// Re-validate the login access of users who ALREADY have a live session. The
// login gate (auth.ts) only runs at sign-in, so once the standings auto-admit is
// disabled/tightened, a standing drifts below threshold, or someone leaves an
// admitted corp, an existing session would otherwise linger to the 7-day cookie
// TTL. This sweeps live sessions and evicts anyone the current gate no longer
// permits.
//
// Called (a) after an admin narrows the access settings (immediate effect) and
// (b) on a periodic timer (catches standing drift + corp changes). Reuses the
// same helpers as the login gate and the same session-kill as an admin block.
import { db } from '../db.js';
import { config } from '../config.js';
import { isLoginPermitted, standingsPermitLogin } from './accessGrants.js';
import { invalidateSessionsForUser } from '../utils/sessionInvalidate.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('accessRevalidate');

export interface RevalidateResult { usersEvicted: number; sessionsKilled: number }

export async function revalidateActiveSessions(): Promise<RevalidateResult> {
  // Solo (unrestricted) deployments have no gate — everyone is allowed, so
  // there is nothing to revoke.
  if (!config.restrictedMode) return { usersEvicted: 0, sessionsKilled: 0 };

  // Distinct users with a LIVE session (connect-pg-simple stores userId in the
  // session JSON; `expire` is the row's TTL). Sessions without a userId (e.g. a
  // bare OAuth-state session) don't join a user row and are skipped.
  const { rows } = await db.query<{
    id: number; characterId: number; corpId: number | null; allianceId: number | null; blocked: boolean;
  }>(
    `SELECT DISTINCT u.id, u.character_id AS "characterId", u.corp_id AS "corpId",
            u.alliance_id AS "allianceId", u.blocked
       FROM sessions s
       JOIN users u ON u.id = (s.sess->>'userId')::int
      WHERE s.expire > NOW() AND s.sess->>'userId' IS NOT NULL`,
  ).catch((err) => {
    // sessions table is created lazily on first login — a brand-new deployment
    // may not have it yet. Nothing to revalidate.
    log.warn('session scan failed:', err);
    return { rows: [] as Array<{ id: number; characterId: number; corpId: number | null; allianceId: number | null; blocked: boolean }> };
  });

  let usersEvicted = 0;
  let sessionsKilled = 0;
  for (const u of rows) {
    // Never evict the configured bootstrap admin — the safety hatch.
    if (config.adminCharId !== null && u.characterId === config.adminCharId) continue;
    const ids = { characterId: u.characterId, corpId: u.corpId, allianceId: u.allianceId };
    const stillOk = !u.blocked && (await isLoginPermitted(ids) || await standingsPermitLogin(ids));
    if (!stillOk) {
      const n = await invalidateSessionsForUser(u.id);
      if (n > 0) { usersEvicted += 1; sessionsKilled += n; }
    }
  }
  if (sessionsKilled > 0) {
    log.info(`Revalidation evicted ${usersEvicted} user(s), ${sessionsKilled} session(s) no longer permitted.`);
  }
  return { usersEvicted, sessionsKilled };
}

// Periodic re-validation timer. Runs in restricted deployments only, on the
// configured cadence (0 disables). Catches standing drift and corp changes that
// an admin action never triggers.
export function startAccessRevalidation(): void {
  if (!config.restrictedMode || config.accessRevalidateMinutes <= 0) return;
  const ms = config.accessRevalidateMinutes * 60 * 1000;
  setInterval(() => { void revalidateActiveSessions().catch((err) => log.error('periodic revalidation failed:', err)); }, ms);
  log.info(`Access re-validation sweep every ${config.accessRevalidateMinutes} min.`);
}
