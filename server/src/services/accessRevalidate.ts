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
import { isLoginPermitted, standingsPermitLogin, pruneStandingDerivedGrants } from './accessGrants.js';
import { invalidateSessionsForUser, refreshSessionAffiliation } from '../utils/sessionInvalidate.js';
import { audit } from './audit.js';
import { esiFetch } from '../utils/esi.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('accessRevalidate');

export interface RevalidateResult { usersEvicted: number; sessionsKilled: number; grantsPruned: number }

interface Affiliation { corpId: number | null; allianceId: number | null }

// Batch-resolve each character's CURRENT corp/alliance via ESI's public
// affiliation endpoint (POST, up to 1000 ids per call). This is how the sweep
// notices a pilot who changed/left corp — the login gate ran only at sign-in, so
// users.corp_id can be stale.
//
// FAIL-SAFE: on ANY error (offline, non-2xx, malformed) we return an EMPTY map so
// callers fall back to the stored ids. An ESI outage must never mass-evict live
// users — worst case we re-check against slightly stale affiliation, same as
// before this feature existed.
async function fetchAffiliations(charIds: number[]): Promise<Map<number, Affiliation>> {
  const out = new Map<number, Affiliation>();
  const ids = [...new Set(charIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const r = await esiFetch('https://esi.evetech.net/latest/characters/affiliation/', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(chunk),
        signal:  AbortSignal.timeout(10_000),
      });
      if (!r.ok) {
        log.warn(`affiliation fetch returned ${r.status} — falling back to stored ids this sweep`);
        return new Map();
      }
      const body = await r.json() as Array<{ character_id: number; corporation_id: number; alliance_id?: number }>;
      if (!Array.isArray(body)) return new Map();
      for (const a of body) out.set(a.character_id, { corpId: a.corporation_id ?? null, allianceId: a.alliance_id ?? null });
    }
  } catch (err) {
    log.warn('affiliation fetch failed — falling back to stored ids this sweep:', err instanceof Error ? err.message : String(err));
    return new Map();
  }
  return out;
}

// opts.refreshAffiliation: re-query each live user's CURRENT corp/alliance from
// ESI before the gate check, so a pilot who changed/left corp is evaluated on
// their real affiliation rather than the stored (stale) value. Used by the
// periodic sweep. The admin-triggered sweeps (grant removed, settings/standings
// changed) leave it OFF — they're reacting to a gate change, not corp drift, and
// shouldn't pay an ESI round-trip in the request path.
export async function revalidateActiveSessions(opts: { refreshAffiliation?: boolean } = {}): Promise<RevalidateResult> {
  // Solo (unrestricted) deployments have no gate — everyone is allowed, so
  // there is nothing to revoke.
  if (!config.restrictedMode) return { usersEvicted: 0, sessionsKilled: 0, grantsPruned: 0 };

  // First, drop any share/standing-derived login grants whose justifying
  // standing no longer holds — so the eviction check below sees the reduced
  // allow-list and boots anyone left with neither a (real) grant nor a standing.
  const grantsPruned = await pruneStandingDerivedGrants();
  if (grantsPruned > 0) log.info(`Pruned ${grantsPruned} standing-derived login grant(s) no longer at positive standing.`);

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

  // Fresh corp/alliance for every live user (empty map when disabled or on ESI
  // failure — then we fall back to the stored ids per-user below).
  const fresh = opts.refreshAffiliation
    ? await fetchAffiliations(rows.map((r) => Number(r.characterId)))
    : new Map<number, Affiliation>();

  let usersEvicted = 0;
  let sessionsKilled = 0;
  for (const u of rows) {
    // character_id is BIGINT — node-pg hands it back as a STRING, so normalise
    // before any numeric comparison. (A `===` against the numeric adminCharId
    // would otherwise never match, and the bootstrap admin would be evicted.)
    const characterId = Number(u.characterId);
    // Never evict the configured bootstrap admin — the safety hatch.
    if (config.adminCharId !== null && characterId === config.adminCharId) continue;

    // Adopt fresh affiliation when we have it; persist + audit a real change so
    // the DB stops being stale. Missing (char deleted / ESI gap) → stored ids.
    let corpId = u.corpId;
    let allianceId = u.allianceId;
    const aff = fresh.get(characterId);
    if (aff) {
      if (aff.corpId !== u.corpId || aff.allianceId !== u.allianceId) {
        await db.query(`UPDATE users SET corp_id = $1, alliance_id = $2, updated_at = NOW() WHERE id = $3`, [aff.corpId, aff.allianceId, u.id]);
        await audit({ session: {} }, u.id, characterId, 'corp_change',
          u.corpId !== null ? String(u.corpId) : null, aff.corpId !== null ? String(aff.corpId) : null);
        // Refresh the live session's corp/alliance scope in place (don't evict —
        // the design keeps sessions across corp moves). Without this, a pilot who
        // changed corp keeps their old corp's map read/write scope until re-login.
        // If they're no longer permitted at all, the eviction below still fires.
        await refreshSessionAffiliation(u.id, aff.corpId, aff.allianceId);
      }
      corpId = aff.corpId;
      allianceId = aff.allianceId;
    }

    const ids = { characterId, corpId, allianceId };
    const stillOk = !u.blocked && (await isLoginPermitted(ids) || await standingsPermitLogin(ids));
    if (!stillOk) {
      const n = await invalidateSessionsForUser(u.id);
      if (n > 0) { usersEvicted += 1; sessionsKilled += n; }
    }
  }
  if (sessionsKilled > 0) {
    log.info(`Revalidation evicted ${usersEvicted} user(s), ${sessionsKilled} session(s) no longer permitted.`);
  }
  return { usersEvicted, sessionsKilled, grantsPruned };
}

// Periodic re-validation timer. Runs in restricted deployments only, on the
// configured cadence (0 disables). Catches standing drift and corp changes that
// an admin action never triggers.
export function startAccessRevalidation(): void {
  if (!config.restrictedMode || config.accessRevalidateMinutes <= 0) return;
  const ms = config.accessRevalidateMinutes * 60 * 1000;
  // Periodic sweep refreshes affiliation from ESI — this is the path that catches
  // a pilot who left an admitted corp without re-logging in.
  setInterval(() => { void revalidateActiveSessions({ refreshAffiliation: true }).catch((err) => log.error('periodic revalidation failed:', err)); }, ms);
  log.info(`Access re-validation sweep every ${config.accessRevalidateMinutes} min.`);
}
