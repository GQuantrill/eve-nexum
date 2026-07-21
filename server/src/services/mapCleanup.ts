// Periodic map-lifecycle cleanup. Two independent sweeps, both restricted-mode
// only (solo deployments have no access gate, so nothing is ever "orphaned"):
//
//   • expireIdleOrgMaps       — corp/alliance maps idle past CORP_MAP_TIME days.
//   • expireOrphanPersonalMaps — personal maps whose OWNER account can no longer
//                                log in, after the same idle grace.
//
// Run on boot + hourly from index.ts.
import { db } from '../db.js';
import { config } from '../config.js';
import { isLoginPermitted, standingsPermitLogin } from './accessGrants.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mapCleanup');

const idleCutoff = (): Date => new Date(Date.now() - config.corpMapExpireDays * 86_400_000);

// Delete corp/alliance maps untouched for CORP_MAP_TIME days. A member's idle
// PERSONAL maps are intentionally excluded here — they're only removed when
// their owner is actually gone (expireOrphanPersonalMaps), never merely for
// being idle. Matches the partial idx_maps_last_active index.
export async function expireIdleOrgMaps(): Promise<number> {
  if (!config.restrictedMode) return 0;
  const { rowCount } = await db.query(
    `DELETE FROM maps WHERE last_active_at < $1 AND (corp_id IS NOT NULL OR alliance_id IS NOT NULL)`,
    [idleCutoff()],
  );
  const n = rowCount ?? 0;
  if (n > 0) log.info(`Expired ${n} inactive corp/alliance map(s).`);
  return n;
}

// Remove PERSONAL maps whose owning account can no longer log in — the pilot
// left/was removed from every admitted corp/alliance, dropped below the
// standings threshold, or was blocked — after the same idle grace as org maps.
// A map is removed iff its owner fails the EXACT login gate (isLoginPermitted OR
// standingsPermitLogin), so "map removed" ⟺ "owner can't log in"; an ACTIVE
// account's personal maps are never touched, however idle. The bootstrap admin
// is exempt (mirrors accessRevalidate's safety hatch).
//
// Note: the idle-grace requirement is what protects a personal map that's still
// being used via a share — an actively-touched map never goes idle, so it's
// never a candidate here even if its original owner has left.
export async function expireOrphanPersonalMaps(): Promise<number> {
  if (!config.restrictedMode) return 0;

  // Idle personal maps tagged with their owning account. owner_id is the account
  // (owners table); legacy maps may have it null, so fall back to the creating
  // user's account, then to a synthetic per-user key (negative, to namespace it
  // away from real owner ids).
  const { rows: maps } = await db.query<{ id: string; accountId: number }>(
    `SELECT m.id, COALESCE(m.owner_id, cu.owner_id, -cu.id) AS "accountId"
       FROM maps m
       JOIN users cu ON cu.id = m.user_id
      WHERE m.corp_id IS NULL AND m.alliance_id IS NULL AND m.last_active_at < $1`,
    [idleCutoff()],
  );
  if (!maps.length) return 0;

  const accountIds  = [...new Set(maps.map((m) => m.accountId))];
  const ownerIds    = accountIds.filter((a) => a > 0);
  const loneUserIds = accountIds.filter((a) => a < 0).map((a) => -a);

  // Every character of every candidate account in one query; each row's key
  // (COALESCE(owner_id, -id)) matches the map's accountId above. The creating
  // user is always included (it's either in the owner set or is the lone user).
  const { rows: chars } = await db.query<{
    accountId: number; characterId: string; corpId: number | null; allianceId: number | null; blocked: boolean;
  }>(
    `SELECT COALESCE(owner_id, -id) AS "accountId",
            character_id AS "characterId", corp_id AS "corpId", alliance_id AS "allianceId", blocked
       FROM users
      WHERE owner_id = ANY($1::int[]) OR id = ANY($2::int[])`,
    [ownerIds, loneUserIds],
  );

  const charsByAccount = new Map<number, typeof chars>();
  for (const c of chars) {
    const list = charsByAccount.get(c.accountId);
    if (list) list.push(c); else charsByAccount.set(c.accountId, [c]);
  }

  // Decide once per account whether ANY of its characters can still log in.
  const permitted = new Map<number, boolean>();
  for (const accountId of accountIds) {
    let ok = false;
    for (const c of charsByAccount.get(accountId) ?? []) {
      // character_id is BIGINT → node-pg hands back a string; normalise before
      // the numeric compare against adminCharId.
      const cid = Number(c.characterId);
      // The bootstrap admin is never orphaned (safety hatch).
      if (config.adminCharId !== null && cid === config.adminCharId) { ok = true; break; }
      if (c.blocked) continue;
      const ids = { characterId: cid, corpId: c.corpId, allianceId: c.allianceId };
      if ((await isLoginPermitted(ids)) || (await standingsPermitLogin(ids))) { ok = true; break; }
    }
    permitted.set(accountId, ok);
  }

  const toDelete = maps.filter((m) => !permitted.get(m.accountId)).map((m) => m.id);
  if (!toDelete.length) return 0;

  const { rowCount } = await db.query(`DELETE FROM maps WHERE id = ANY($1::uuid[])`, [toDelete]);
  const n = rowCount ?? 0;
  if (n > 0) log.info(`Removed ${n} orphaned personal map(s) whose owner can no longer log in.`);
  return n;
}
