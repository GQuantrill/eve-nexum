import { Router } from 'express';
import { esiFetch } from '../utils/esi.js';
import type { Request, Response } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authUser, isAdmin, isAllianceAdmin } from '../middleware/authContext.js';
import { config } from '../config.js';
import { standingPermitsTarget, grantKindAllowedForInstall, requiresPositiveStanding } from '../services/accessGrants.js';
import { decryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';
import { resolveOwnerId } from '../utils/owner.js';
import { resolveEntityNames } from '../services/entityNames.js';
import { audit } from '../services/audit.js';
import { publishToMap } from '../services/mapEvents.js';
import { streamMapEvents } from '../services/mapStream.js';
import { listVisibleMaps, loadFullMap, loadSystemSignatures, loadSystemAnomalies, loadSystemStructures, CONNECTION_COLS } from '../services/mapRead.js';
import { listConnectionJumps, recordConnectionJump, setConnectionJumpHot, clearConnectionJumps } from '../services/connectionJumps.js';
import {
  createSignature, updateSignature, deleteSignature,
  createAnomaly, updateAnomaly, deleteAnomaly,
  createStructure, updateStructure, deleteStructure,
} from '../services/mapWrite.js';
import { reportPresence } from '../services/presence.js';
import { copyMap } from '../services/mapCopy.js';
import { notifyDiscord, k162Embed, connectionEmbed, chainEmbed, kspaceExitEmbed } from '../services/discord.js';
import { shortestRoutes } from '../services/routeGraph.js';
import { whSizeForCode } from './wormholes.js';
import { effectiveExpiryMs, lifeBucket } from '../data/whLifetimes.js';
import { buildKillRow } from '../services/killFeed.js';
import { recentKillsForSystems } from '../services/killBuffer.js';

const log = createLogger('maps');
const discordLog = createLogger('discord');

// EVE system name → numeric ID lookup against the SDE-seeded solar_systems
// table. Used to backfill eve_system_id at write time when the client posts
// a system with only a name (e.g. wormhole picker / sig-paste paths that
// recognise the name but never resolved the ID). Returns null for unknown
// names, the existing ID if the caller already passed one in, or null on
// empty input. Idempotent and cheap — a single indexed equality lookup.
async function resolveEveSystemId(
  given: number | null | undefined,
  name: string | null | undefined,
): Promise<number | null> {
  if (typeof given === 'number' && Number.isFinite(given)) return given;
  if (!name) return null;
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM solar_systems WHERE name = $1`,
    [name],
  );
  return rows[0]?.id ?? null;
}

// Best-effort ESI lookup of a player structure's owner corp ID. Requires
// the user's `esi-universe.read_structures.v1` scope and access to the
// structure itself (member of the owning corp or its alliance, or it
// being a public structure). 403/404 just means "we can't resolve it",
// not an error.
export async function resolveStructureOwnerCorp(
  userId: number,
  eveStructureId: number,
): Promise<number | null> {
  try {
    const { rows } = await db.query<{ access_token: string }>(
      `SELECT access_token FROM users WHERE id = $1`, [userId],
    );
    if (!rows.length) return null;
    const token = decryptToken(rows[0].access_token);
    const r = await esiFetch(`https://esi.evetech.net/v2/universe/structures/${eveStructureId}/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      if (r.status !== 403 && r.status !== 404) {
        log.warn(`ESI structure ${eveStructureId} returned ${r.status}`);
      }
      return null;
    }
    const data = await r.json() as { owner_id?: number };
    return data.owner_id ?? null;
  } catch (err) {
    log.error('resolveStructureOwnerCorp failed:', err);
    return null;
  }
}

export const mapsRouter = Router();
mapsRouter.use(requireAuth);

// ── Access control helpers ────────────────────────────────────────────────────

// How the current user can see this map. Determines which writes are allowed:
//   - owner          : their personal map (or a corp map they happened to create)
//   - corp_member    : visible via corp membership; role-gated for writes
//   - alliance_member: visible via alliance membership; role-gated for writes,
//                      lifecycle/management is alliance_admin-only
//   - shared         : explicit map_shares grant (character or corp) — full edit,
//                      no role check, but lock + owner-only ops still apply
export type AccessKind = 'owner' | 'corp_member' | 'alliance_member' | 'shared';
export interface MapMeta {
  userId:     number;
  corpId:     number | null;
  allianceId: number | null;
  locked:     boolean;
  accessKind: AccessKind;
  // Only meaningful when accessKind === 'shared': did the grant confer edit
  // rights (true) or view-only (false)? Undefined for owner/corp/alliance access.
  shareCanWrite?: boolean;
}

// UUID-shape guard. The maps router takes :mapId straight from the URL,
// and Postgres' uuid type throws a 22P02 on malformed input — which would
// crash the whole process as an unhandled async rejection. Cheap regex
// up front keeps that case as a clean 404.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function getMapAccess(mapId: string, req: Request): Promise<MapMeta | null> {
  if (!UUID_RE.test(mapId)) return null;
  // Resolve identity from EITHER the session or an API-key context (req.apiAuth),
  // so the same access logic serves cookie clients and external API keys.
  const auth           = authUser(req);
  const userId         = auth.userId;
  const userCorpId     = auth.corpId;
  const userAllianceId = auth.allianceId;

  // Pull map + caller's EVE character id in one round-trip; the latter is
  // needed to match against map_shares.target_character_id.
  const { rows } = await db.query<{
    userId:     number;
    corpId:     number | null;
    allianceId: number | null;
    locked:     boolean;
    callerChar: number;
    mapOwner:    number | null;
    callerOwner: number | null;
  }>(
    `SELECT m.user_id AS "userId",
            m.corp_id AS "corpId",
            m.alliance_id AS "allianceId",
            m.locked,
            m.owner_id AS "mapOwner",
            u.character_id AS "callerChar",
            u.owner_id AS "callerOwner"
       FROM maps m
       JOIN users u ON u.id = $2
      WHERE m.id = $1`,
    [mapId, userId],
  );
  if (!rows.length) return null;
  const m = rows[0];
  const meta = (accessKind: AccessKind): MapMeta =>
    ({ userId: m.userId, corpId: m.corpId, allianceId: m.allianceId, locked: m.locked, accessKind });

  // Owner = this account. A map belongs to the account that owns it (any of
  // the account's characters), with a defensive fall back to the creating
  // character so you can never lose access to a map you made even if owner_id
  // is somehow unset.
  if (m.userId === userId || (m.mapOwner != null && m.callerOwner != null && m.mapOwner === m.callerOwner)) {
    return meta('owner');
  }

  // Corp map access. Two ways in:
  //   • Explicit corp deployment (CORP_ID): the map's corp must be listed;
  //     CORP_MAP_SHARED decides whether other listed corps see it.
  //   • Alliance deployment: any corp inside the (login-gated) alliance keeps
  //     its own corp map, visible to same-corp members — no CORP_ID list, since
  //     enumerating every member corp is unmanageable for a large alliance.
  const isCorpMap = m.corpId !== null && (
    (config.corpMode && config.corpIds.includes(m.corpId) && (config.corpMapShared || m.corpId === userCorpId))
    || (config.allianceMode && m.corpId === userCorpId)
  );
  if (isCorpMap) {
    return meta('corp_member');
  }

  // Alliance map: visible to members of the owning alliance (or every listed
  // alliance under ALLIANCE_MAP_SHARED). Mirrors the corp branch one scope up.
  const isAllianceMap = config.allianceMode
    && m.allianceId !== null
    && config.allianceIds.includes(m.allianceId)
    && (config.allianceMapShared || m.allianceId === userAllianceId);
  if (isAllianceMap) {
    return meta('alliance_member');
  }

  // Shared with this character / their corp / their alliance via an explicit
  // grant. Applies to ANY map scope: owner and corp/alliance members already
  // matched above, so this branch only ever admits a NON-member whom the owner
  // (or a corp/alliance admin) deliberately invited. The grant's can_write
  // decides view-only vs edit; if several grants match the same caller, the
  // most permissive wins. Corp/alliance grants resolve against the caller's
  // *current* ids, so switching corp/alliance moves access with them.
  const share = await db.query<{ canWrite: boolean }>(
    `SELECT can_write AS "canWrite" FROM map_shares
       WHERE map_id = $1
         AND ( target_character_id = $2
            OR ($3::int IS NOT NULL AND target_corp_id = $3)
            OR ($4::int IS NOT NULL AND target_alliance_id = $4) )
       ORDER BY can_write DESC
       LIMIT 1`,
    [mapId, m.callerChar, userCorpId, userAllianceId],
  );
  if (share.rowCount && share.rowCount > 0) {
    return { userId: m.userId, corpId: m.corpId, allianceId: m.allianceId,
             locked: m.locked, accessKind: 'shared', shareCanWrite: share.rows[0].canWrite };
  }

  return null;
}

// Strict owner gate. Used for the handful of operations that cross the
// "this is yours" line — rename, delete, lock, manage grants, generate
// public share links. Shared recipients explicitly cannot do these.
async function requireMapOwner(res: Response, mapId: string, req: Request): Promise<MapMeta | null> {
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return null; }
  if (access.accessKind !== 'owner') {
    res.status(403).json({ error: 'Only the owner can perform this action' });
    return null;
  }
  return access;
}

// Two tiers of write permission:
//
//   - requireMapContentWrite enforces *only* the role check. Used for routes
//     that mutate per-system content (signatures, structures, notes). An
//     admin-applied map lock freezes topology but leaves these open so the
//     map can still be used operationally while the layout is frozen.
//
//   - requireMapWrite is the strict version — role check plus lock check.
//     Used for everything that changes the map's *shape*: adding/removing
//     systems, moving systems, connections, map rename.
//
// Both helpers send the appropriate 403/404 and return null on failure.
export async function requireMapContentWrite(res: Response, mapId: string, req: Request): Promise<MapMeta | null> {
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return null; }

  const acting = authUser(req);
  // API-key writes need the 'write' scope; a 'read'/'events' key is refused
  // here regardless of the bound character's role. A 'write' key then still
  // passes through the same role check below (it acts as its bound character).
  if (acting.apiScope && acting.apiScope !== 'write') {
    res.status(403).json({ error: "This API key cannot write (needs the 'write' scope)" }); return null;
  }

  const role = acting.role;

  // The map's OWNER always writes it. Every other way in — corp member,
  // alliance member, OR an explicit share grant — remains bound by the caller's
  // own deployment role: a 'readonly' identity can view but never write, even to
  // a map shared with edit. A share only opens the DOOR to a map; normal roles
  // still govern what you can do once inside (solo installs make everyone
  // 'admin', so this only constrains restricted corp/alliance deployments).
  if (access.accessKind !== 'owner' && role === 'readonly') {
    res.status(403).json({ error: 'Write access required' }); return null;
  }
  // A view-only share grant (can_write = false) is a further, role-independent
  // ceiling: even an edit/full/admin recipient can only READ a map shared with
  // them view-only.
  if (access.accessKind === 'shared' && access.shareCanWrite === false) {
    res.status(403).json({ error: 'This map was shared with you view-only' }); return null;
  }
  return access;
}

async function requireMapWrite(res: Response, mapId: string, req: Request): Promise<MapMeta | null> {
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return null;

  // Topology (systems/connections/rename) is human-only — even a 'write' key,
  // which clears requireMapContentWrite above, can't reshape the map.
  if (authUser(req).apiScope) {
    res.status(403).json({ error: 'API keys cannot modify map topology' }); return null;
  }
  // Lock bypass mirrors who may toggle the lock: alliance maps need an alliance
  // admin, corp/personal maps an ordinary admin — so a corp admin can't edit
  // through an alliance lock they aren't allowed to set.
  const bypassRole = authUser(req).role;
  const canBypassLock = access.allianceId !== null ? isAllianceAdmin(bypassRole) : isAdmin(bypassRole);
  if (access.locked && !canBypassLock) {
    res.status(403).json({ error: 'Map is locked' }); return null;
  }
  return access;
}

// ── Discord intel webhooks ────────────────────────────────────────────────────
// Best-effort, corp-maps-only notifications. These resolve the human-readable
// names off the request path and enqueue; they never block the handler or throw
// (a webhook failure must not affect the user's action). Hooked into the
// interactive handlers — never the bulk seed/merge paths — so a region seed
// can't flood the channel. See discord_webhooks_feature.md.
//
// Per-corp region + per-map filtering (see discord_filters_feature.md) is
// applied at send time: a notification goes out only if the map isn't excluded
// AND the corp accepts the event's region. `regionAllowed` is the region half —
// pass on `all_regions`, or if any of the event's system regions is allowlisted.
function regionAllowed(allRegions: boolean, allow: string[], names: (string | null)[]): boolean {
  if (allRegions) return true;
  return names.some((n) => n != null && allow.includes(n));
}

// K162 notifications are deferred briefly so a follow-up edit — most usefully
// the wormhole's "leads to" — can be picked up and included. The send is keyed
// by signature id; at fire time we re-read the signature and send whatever it
// is *then* (skipping it if it's no longer a K162). A fixed cap means we never
// wait longer than this, and a second detection for an already-pending sig is
// ignored so the original deadline stands.
const K162_DEFER_MS = 10_000;
interface PendingK162 { timer: ReturnType<typeof setTimeout>; actor: string | null; }
const pendingK162 = new Map<string, PendingK162>();

// True when a map has an owning org that could have webhooks (corp or alliance).
// Personal maps never notify, so we skip them without a DB round-trip.
function hasOrg(meta: MapMeta): boolean { return meta.corpId != null || meta.allianceId != null; }

export function dispatchK162(meta: MapMeta, sigId: string, systemId: string, actor: string | null): void {
  if (!hasOrg(meta)) {
    discordLog.info(`K162 detected (system ${systemId}) but not sending — personal map (no corp/alliance)`);
    return;
  }
  if (pendingK162.has(sigId)) {
    discordLog.info(`K162 (sig ${sigId}) already pending — keeping the existing ${K162_DEFER_MS / 1000}s window`);
    return;
  }
  discordLog.info(`K162 on org map (corpId=${meta.corpId ?? 'null'}/allianceId=${meta.allianceId ?? 'null'}, sig ${sigId}) — deferring ${K162_DEFER_MS / 1000}s to catch a leads-to`);
  const timer = setTimeout(() => {
    pendingK162.delete(sigId);
    void fireK162(sigId, actor);
  }, K162_DEFER_MS);
  pendingK162.set(sigId, { timer, actor });
}

// Send a pending K162 immediately — e.g. once its leads-to has been filled in —
// instead of waiting out the rest of the defer window. No-op if nothing is
// pending for this signature. Fires with the original detection's context.
export function flushK162(sigId: string): void {
  const p = pendingK162.get(sigId);
  if (!p) return;
  clearTimeout(p.timer);
  pendingK162.delete(sigId);
  discordLog.info(`K162 (sig ${sigId}) leads-to set — sending now instead of waiting`);
  void fireK162(sigId, p.actor);
}

// The Discord settings resolved for a map's org (corp OR alliance), read by LEFT
// JOINing both settings tables on the map's own corp_id / alliance_id — a map
// matches exactly one, so COALESCE picks that row (or the permissive defaults
// when the org has never saved settings). Includes the per-event webhook URLs.
const DISCORD_SETTINGS_JOIN = `
  LEFT JOIN corp_discord_settings     cds ON cds.corp_id     = m.corp_id
  LEFT JOIN alliance_discord_settings ads ON ads.alliance_id = m.alliance_id`;
const DISCORD_SETTINGS_COLS = `
  COALESCE(cds.all_regions,   ads.all_regions,   TRUE)          AS "allRegions",
  COALESCE(cds.regions,       ads.regions,       '{}'::text[])  AS "regions",
  COALESCE(cds.notify_chains, ads.notify_chains, TRUE)          AS "notifyChains",
  COALESCE(cds.connections_webhook, ads.connections_webhook)    AS "connectionsWebhook",
  COALESCE(cds.chains_webhook,      ads.chains_webhook)         AS "chainsWebhook",
  COALESCE(cds.exits_min_security,  ads.exits_min_security, 0.45) AS "exitsMinSecurity"`;

// leads-to tokens that are a class/band/unknown rather than a pinned system —
// mirrors the client's CLASS_OR_UNKNOWN set. A leads-to NOT in here is a
// specific connected system, i.e. the hole is resolved to a real destination.
const LEADS_TO_NON_SYSTEM = new Set([
  '', 'UNKNOWN',
  'C1-C3', 'C4-C5', 'C6', 'C13', 'THERA', 'POCHVEN', 'DRIFTER',
  'HS', 'LS', 'NS',
  'C1', 'C2', 'C3', 'C4', 'C5',
]);
// True once a hole's leads-to names a specific destination system (not empty,
// "unknown", or a class/band). Discord notifications fire only then — an
// unknown/class-only hole is surfaced on the map instead, not broadcast.
function leadsToIsSystem(leadsTo: string | null): boolean {
  return !LEADS_TO_NON_SYSTEM.has((leadsTo ?? '').trim().toUpperCase());
}

// Re-read the signature now (after the defer window) and send if it's still a
// K162, including the leads-to if one was set in the meantime.
async function fireK162(sigId: string, actor: string | null): Promise<void> {
  try {
    const { rows } = await db.query<{
      whType: string | null; leadsTo: string | null; system: string; systemClass: string;
      region: string | null; mapName: string; mapEnabled: boolean; allRegions: boolean; regions: string[];
      connectionsWebhook: string | null; connectedToDest: boolean;
    }>(
      // `connectedToDest`: a wormhole connection already links this K162's system
      // to the system its leads-to names — i.e. the far side of a hole we've
      // already mapped (and broadcast) from the other end. When true we skip the
      // K162 ping so the same hole isn't announced twice.
      `SELECT sg.wh_type AS "whType", sg.wh_leads_to AS "leadsTo",
              s.name AS "system", s.system_class AS "systemClass", s.region_name AS "region",
              m.name AS "mapName", m.discord_notify AS "mapEnabled",
              ${DISCORD_SETTINGS_COLS},
              EXISTS (
                SELECT 1 FROM map_connections c
                  JOIN map_systems os
                    ON os.id = (CASE WHEN c.source_id = s.id THEN c.target_id ELSE c.source_id END)
                 WHERE c.map_id = m.id
                   AND c.connection_type = 'standard'
                   AND (c.source_id = s.id OR c.target_id = s.id)
                   AND UPPER(os.name) = UPPER(sg.wh_leads_to)
              ) AS "connectedToDest"
         FROM map_signatures sg
         JOIN map_systems s ON s.id = sg.system_id
         JOIN maps m ON m.id = s.map_id
         ${DISCORD_SETTINGS_JOIN}
        WHERE sg.id = $1`,
      [sigId],
    );
    const r = rows[0];
    if (!r) { discordLog.info(`K162 (sig ${sigId}) removed before send — skipping`); return; }
    if (!r.connectionsWebhook) { discordLog.info(`K162 (sig ${sigId}) suppressed — no connections webhook configured`); return; }
    if ((r.whType ?? '').toUpperCase() !== 'K162') {
      discordLog.info(`K162 (sig ${sigId}) changed to "${r.whType ?? ''}" before send — skipping`);
      return;
    }
    if (!r.mapEnabled) {
      discordLog.info(`K162 (sig ${sigId}) suppressed — map "${r.mapName}" is excluded from Discord`);
      return;
    }
    if (!regionAllowed(r.allRegions, r.regions, [r.region])) {
      discordLog.info(`K162 (sig ${sigId}) suppressed — region "${r.region ?? 'unknown'}" not in the org filter`);
      return;
    }
    if (!leadsToIsSystem(r.leadsTo)) {
      discordLog.info(`K162 (sig ${sigId}) suppressed — leads-to "${r.leadsTo ?? 'unknown'}" is not a specific destination system`);
      return;
    }
    if (r.connectedToDest) {
      discordLog.info(`K162 (sig ${sigId}) suppressed — "${r.system}" is already connected to "${r.leadsTo}"; that hole was broadcast from the other end`);
      return;
    }
    notifyDiscord(r.connectionsWebhook, k162Embed({ system: r.system, systemClass: r.systemClass, leadsTo: r.leadsTo, mapName: r.mapName, actor }));
  } catch (e) {
    discordLog.warn(`K162 deferred dispatch failed: ${(e as Error).message}`);
  }
}

// The leads-to "band" a wormhole signature uses for an arrival class — mirrors
// whJumpConfirm.bandFor on the client so the server's wormhole-evidence check
// stays in step with what the client would treat as a plausible hole.
function whBand(cls: string): string {
  if (cls === 'C1' || cls === 'C2' || cls === 'C3') return 'C1-C3';
  if (cls === 'C4' || cls === 'C5') return 'C4-C5';
  return cls; // C6 / C13 / Thera / Pochven / Drifter / HS / LS / NS
}

// The wh_leads_to values a hole in `fromClass`-space could carry and still be a
// plausible candidate for a jump that ARRIVED in a `toClass`/`toName` system:
// unscanned ('' / 'unknown'), pinned to that exact system, or class/band-matched.
// (A hole pinned to a different system name is excluded — it's already solved.)
function candidateLeadsTo(toName: string, toClass: string): string[] {
  return ['', 'unknown', toName, whBand(toClass), toClass];
}

// Whether a jump between two systems looks like a real WORMHOLE jump rather than
// a gate / Ansiblex / bridge: at least one endpoint must hold a scanned wormhole
// signature that plausibly accounts for the hop. In-game gates are already typed
// 'gate' and never reach here; this catches jump-bridge hops between k-space
// systems that the stargate check can't (they aren't stargate-adjacent), which
// otherwise looked like fresh wormholes.
//
// Returns { backed, whType }: backed=false → suppress (no wormhole evidence);
// whType is the backing hole's type code for the embed + type filter, preferring
// the source-side sig's real code (e.g. 'C247') over a bare 'K162' twin, '' when
// unknown. Best-effort: on a query error we assume it IS a wormhole (fail-open,
// unknown type) rather than silently dropping a real one.
async function wormholeEvidence(
  sourceId: string, targetId: string,
  aName: string, aClass: string, bName: string, bClass: string,
): Promise<{ backed: boolean; whType: string }> {
  try {
    const { rows } = await db.query<{ whType: string | null }>(
      `SELECT sg.wh_type AS "whType"
         FROM map_signatures sg
        WHERE sg.sig_type = 'wormhole'
          AND ( (sg.system_id = $1 AND sg.wh_leads_to = ANY($3::text[]))
             OR (sg.system_id = $2 AND sg.wh_leads_to = ANY($4::text[])) )
        ORDER BY CASE WHEN COALESCE(sg.wh_type, '') NOT IN ('', 'K162') THEN 0 ELSE 1 END
        LIMIT 1`,
      [sourceId, targetId, candidateLeadsTo(bName, bClass), candidateLeadsTo(aName, aClass)],
    );
    if (rows.length === 0) return { backed: false, whType: '' };
    return { backed: true, whType: (rows[0].whType ?? '').toUpperCase() };
  } catch (e) {
    discordLog.warn(`wormhole-evidence check failed (assuming wormhole): ${(e as Error).message}`);
    return { backed: true, whType: '' };
  }
}

// Wormhole notification filters (type code / dest class / size). An empty list
// means "all" (the default). Type is fail-open on an unknown/empty code so a
// hole whose type isn't scanned yet is never silently dropped by a type filter;
// class and size are always known, so they match strictly.
function whListAllows(list: string[], value: string): boolean {
  return list.length === 0 || list.includes(value);
}
function whTypeAllows(list: string[], code: string): boolean {
  return list.length === 0 || code === '' || list.includes(code);
}

// Trade hubs (eve solar-system ids) used to size up a freshly revealed k-space
// exit: the nearest one by stargate jumps is reported in the rich exit embed.
const TRADE_HUBS: { id: number; name: string }[] = [
  { id: 30000142, name: 'Jita' },
  { id: 30002187, name: 'Amarr' },
  { id: 30002510, name: 'Rens' },
  { id: 30002659, name: 'Dodixie' },
  { id: 30002053, name: 'Hek' },
];

// K-space system classes — the "exits" a wormhole chain can drop you into.
const KSPACE_EXIT_CLASSES = new Set(['HS', 'LS', 'NS']);

interface ExitIntel {
  pathNames:   string[];                              // home … exit, inclusive
  whJumps:     number;                                // wormhole ('standard') hops in that path
  gateJumps:   number;                                // in-chain gate / Ansiblex hops (non-wormhole)
  maxShipSize: string;                                // tightest wormhole on the route (largest ship that fits)
  hub:         { name: string; jumps: number } | null; // nearest trade hub by stargate
  total:       number;                                // whJumps + gateJumps + hub jumps
}

// Routing intel for a k-space exit newly revealed on a map: the shortest
// wormhole-chain path from the map's home to the exit (BFS over the map's live
// connections), plus the nearest trade hub by stargate jumps from the exit.
// Returns null when the map has no home or the exit isn't reachable from it —
// callers then fall back to the plain connection embed.
async function computeExitIntel(mapId: string, exitNodeId: string): Promise<ExitIntel | null> {
  const [sysRes, connRes] = await Promise.all([
    db.query<{ id: string; name: string; eve_system_id: number | null; is_home: boolean }>(
      `SELECT id, name, eve_system_id, is_home FROM map_systems WHERE map_id = $1`, [mapId]),
    db.query<{ source_id: string; target_id: string; connection_type: string; size: string | null }>(
      `SELECT source_id, target_id, connection_type, size FROM map_connections WHERE map_id = $1 AND broken = FALSE`, [mapId]),
  ]);

  const nodes = new Map<string, { name: string; eve: number | null }>();
  let homeId: string | null = null;
  for (const s of sysRes.rows) {
    nodes.set(s.id, { name: s.name, eve: s.eve_system_id });
    if (s.is_home && homeId === null) homeId = s.id; // first home wins
  }
  if (homeId === null || !nodes.has(exitNodeId)) return null;

  // Undirected adjacency over the map's un-broken connections, plus each edge's
  // type so chain hops can be split into wormhole vs gate below.
  const adj = new Map<string, string[]>();
  const edgeType = new Map<string, string>();         // "a|b" (both directions) -> connection_type
  const edgeSize = new Map<string, string | null>();  // "a|b" -> jump-size class (wormholes only matter)
  const link = (a: string, b: string, type: string, size: string | null) => {
    const l = adj.get(a); if (l) l.push(b); else adj.set(a, [b]);
    edgeType.set(`${a}|${b}`, type);
    edgeSize.set(`${a}|${b}`, size);
  };
  for (const c of connRes.rows) {
    link(c.source_id, c.target_id, c.connection_type, c.size);
    link(c.target_id, c.source_id, c.connection_type, c.size);
  }

  // BFS home → exit, tracking predecessors to rebuild the shortest path.
  const prev = new Map<string, string>();
  const seen = new Set<string>([homeId]);
  const queue: string[] = [homeId];
  let head = 0;
  let found = homeId === exitNodeId;
  while (head < queue.length && !found) {
    const cur = queue[head++];
    for (const n of adj.get(cur) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, cur);
      if (n === exitNodeId) { found = true; break; }
      queue.push(n);
    }
  }
  if (!found) return null;

  const idPath: string[] = [];
  for (let cur: string | undefined = exitNodeId; cur !== undefined; cur = prev.get(cur)) {
    idPath.push(cur);
    if (cur === homeId) break;
  }
  idPath.reverse();
  const pathNames = idPath.map((id) => nodes.get(id)?.name ?? '?');
  // Split the chain hops: a 'standard' link is a wormhole jump; a 'gate'
  // (stargate) or 'jumpgate' (Ansiblex) link is a gate jump — so a chain that
  // crosses k-space by gate isn't miscounted as wormholes. Collect the wormhole
  // hops' sizes so the tightest (largest ship that fits the whole trip) shows.
  let whJumps = 0, gateJumps = 0;
  const whSizes: string[] = [];
  for (let i = 1; i < idPath.length; i++) {
    const key = `${idPath[i - 1]}|${idPath[i]}`;
    if (edgeType.get(key) === 'standard') {
      whJumps++;
      const sz = edgeSize.get(key);
      if (sz) whSizes.push(sz);
    } else {
      gateJumps++;
    }
  }
  const maxShipSize = chainMaxSize(whSizes);

  // Nearest trade hub by stargate jumps from the exit's eve system.
  const exitEve = nodes.get(exitNodeId)?.eve ?? null;
  const hub = exitEve != null ? await nearestTradeHub(exitEve) : null;
  return { pathNames, whJumps, gateJumps, maxShipSize, hub, total: whJumps + gateJumps + (hub?.jumps ?? 0) };
}

// Nearest trade hub to a k-space system by stargate jumps, or null if none is
// reachable (or the route graph is unavailable). Used both by the rich exit
// intel and by the plain connection embed when an endpoint is k-space.
async function nearestTradeHub(exitEve: number): Promise<{ name: string; jumps: number } | null> {
  const routes = await shortestRoutes(exitEve, TRADE_HUBS.map((h) => h.id), 'shortest');
  let hub: { name: string; jumps: number } | null = null;
  for (const h of TRADE_HUBS) {
    const entry = routes[h.id];
    if (entry && (hub === null || entry.jumps < hub.jumps)) hub = { name: h.name, jumps: entry.jumps };
  }
  return hub;
}

interface KspaceExitPick {
  nodeId: string; name: string; region: string | null; security: number;
  connectedName: string; connectedClass: string;
}

// Choose which endpoint of a connection to treat as the k-space EXIT for the
// rich routing embed, or null when neither qualifies. An endpoint qualifies when
// it's HS/LS/NS with a known security at/above the org's minimum. When both
// sides qualify (e.g. HS↔HS) the home endpoint is never the exit; failing that
// the higher-security side wins. The other endpoint is the connected-to wormhole.
function pickKspaceExit(r: {
  sourceId: string; targetId: string; a: string; b: string; classA: string; classB: string;
  regionA: string | null; regionB: string | null; secA: number | null; secB: number | null;
  homeA: boolean; homeB: boolean; exitsMinSecurity: number;
}): KspaceExitPick | null {
  const qualifies = (cls: string, sec: number | null): boolean =>
    KSPACE_EXIT_CLASSES.has(cls) && sec != null && sec >= r.exitsMinSecurity;
  const aOk = qualifies(r.classA, r.secA);
  const bOk = qualifies(r.classB, r.secB);
  if (!aOk && !bOk) return null;

  const sideA: KspaceExitPick = { nodeId: r.sourceId, name: r.a, region: r.regionA, security: r.secA as number, connectedName: r.b, connectedClass: r.classB };
  const sideB: KspaceExitPick = { nodeId: r.targetId, name: r.b, region: r.regionB, security: r.secB as number, connectedName: r.a, connectedClass: r.classA };
  if (aOk && !bOk) return sideA;
  if (bOk && !aOk) return sideB;
  // Both qualify: prefer the non-home side, else the higher-security one.
  if (r.homeA && !r.homeB) return sideB;
  if (r.homeB && !r.homeA) return sideA;
  return (r.secB as number) > (r.secA as number) ? sideB : sideA;
}

// The k-space endpoint whose nearest trade hub the plain connection embed should
// report — the exit you'd travel to. When exactly one side is k-space it's that
// side; when both are (e.g. a NS↔HS static) the non-home side, then the
// higher-security one. Wormhole-only connections have no hub, so return null.
function kspaceHubEve(r: {
  classA: string; classB: string; eveA: number | null; eveB: number | null;
  homeA: boolean; homeB: boolean; secA: number | null; secB: number | null;
}): number | null {
  const aOk = KSPACE_EXIT_CLASSES.has(r.classA) && r.eveA != null;
  const bOk = KSPACE_EXIT_CLASSES.has(r.classB) && r.eveB != null;
  if (aOk && !bOk) return r.eveA;
  if (bOk && !aOk) return r.eveB;
  if (aOk && bOk) {
    if (r.homeA && !r.homeB) return r.eveB;
    if (r.homeB && !r.homeA) return r.eveA;
    return (r.secB ?? 0) > (r.secA ?? 0) ? r.eveB : r.eveA;
  }
  return null;
}

// Broadcast a wormhole connection — at most once per connection. Keyed on the
// connection id (not just its endpoints) so it can be re-checked whenever the
// connection changes: created by a jump (sig already present), created manually
// then backed by a sig later, or its type filled in by auto-detect. The
// `discord_notified` flag is set only on a real send, so a connection that is
// suppressed now (no backing sig yet) can still fire once the sig arrives, and
// one already sent never re-broadcasts.
function maybeBroadcastConnection(meta: MapMeta, mapId: string, connId: string, actor: string | null): void {
  if (!hasOrg(meta)) return; // personal map — never notifies
  db.query<{
    sourceId: string; targetId: string; connType: string; notified: boolean; notifiedKnown: boolean; size: string | null; whType: string | null;
    a: string; b: string; classA: string; classB: string; regionA: string | null; regionB: string | null;
    eveA: number | null; eveB: number | null; secA: number | null; secB: number | null; homeA: boolean; homeB: boolean;
    mapName: string; mapEnabled: boolean; allRegions: boolean; regions: string[];
    whTypes: string[]; whClasses: string[]; whSizes: string[]; connectionsWebhook: string | null; exitsMinSecurity: number;
  }>(
    `SELECT c.source_id AS "sourceId", c.target_id AS "targetId", c.connection_type AS "connType",
            c.discord_notified AS "notified", c.discord_notified_known AS "notifiedKnown", c.size, c.wh_type AS "whType",
            a.name AS a, b.name AS b, a.system_class AS "classA", b.system_class AS "classB",
            a.region_name AS "regionA", b.region_name AS "regionB",
            a.eve_system_id AS "eveA", b.eve_system_id AS "eveB",
            ssa.security::float8 AS "secA", ssb.security::float8 AS "secB",
            a.is_home AS "homeA", b.is_home AS "homeB",
            m.name AS "mapName", m.discord_notify AS "mapEnabled",
            ${DISCORD_SETTINGS_COLS},
            COALESCE(cds.wh_types,   ads.wh_types,   '{}'::text[]) AS "whTypes",
            COALESCE(cds.wh_classes, ads.wh_classes, '{}'::text[]) AS "whClasses",
            COALESCE(cds.wh_sizes,   ads.wh_sizes,   '{}'::text[]) AS "whSizes"
       FROM map_connections c
       JOIN maps m ON m.id = c.map_id
       JOIN map_systems a ON a.id = c.source_id
       JOIN map_systems b ON b.id = c.target_id
       LEFT JOIN solar_systems ssa ON ssa.id = a.eve_system_id
       LEFT JOIN solar_systems ssb ON ssb.id = b.eve_system_id
       ${DISCORD_SETTINGS_JOIN}
      WHERE c.id = $1 AND c.map_id = $2`,
    [connId, mapId],
  ).then(async ({ rows }) => {
    const r = rows[0];
    if (!r) { discordLog.warn(`connection dispatch: connection ${connId} not found`); return; }
    // Broadcast at most twice: once when the hole is first confirmed (even as an
    // unknown K162), then once more when its real type becomes known. Once we've
    // announced a known type, never again.
    if (r.notified && r.notifiedKnown) return;
    if (r.connType !== 'standard') return; // gate / Ansiblex / jump-bridge
    if (!r.connectionsWebhook) { discordLog.info(`connection ${r.a} <-> ${r.b} suppressed — no connections webhook configured`); return; }
    if (!r.mapEnabled) {
      discordLog.info(`connection ${r.a} <-> ${r.b} suppressed — map "${r.mapName}" is excluded from Discord`);
      return;
    }
    if (!regionAllowed(r.allRegions, r.regions, [r.regionA, r.regionB])) {
      discordLog.info(`connection ${r.a} <-> ${r.b} suppressed — neither region (${r.regionA ?? '?'} / ${r.regionB ?? '?'}) in the org filter`);
      return;
    }
    // Suppress gate / Ansiblex / bridge hops: only broadcast when a scanned
    // wormhole signature plausibly backs the jump (see wormholeEvidence). Left
    // unsent (flag not set) so it can fire once the sig is added.
    const ev = await wormholeEvidence(r.sourceId, r.targetId, r.a, r.classA, r.b, r.classB);
    if (!ev.backed) {
      discordLog.info(`connection ${r.a} <-> ${r.b} not broadcast yet — no wormhole signature backs it (gate/bridge, or sig not scanned)`);
      return;
    }
    // The resolved hole type and whether we actually know it. A bare K162 (or no
    // code) is "unknown" — its size can't be derived and it may upgrade later.
    const code = (ev.whType || r.whType || '').toUpperCase();
    const known = code !== '' && code !== 'K162';
    // Already announced this hole and its type is still unknown — wait for a real
    // code before pinging again.
    if (r.notified && !known) return;
    // Wormhole filters (dest class = the "to" end; size from the type).
    if (!whTypeAllows(r.whTypes, ev.whType)) {
      discordLog.info(`connection ${r.a} <-> ${r.b} suppressed — hole type "${ev.whType || '?'}" not in the org's type filter`);
      return;
    }
    // Turnur is a distinct destination option (like Thera), even though the SDE
    // classes it low-sec — so a Turnur hole matches the 'Turnur' filter.
    const destClass = r.b === 'Turnur' ? 'Turnur' : r.classB;
    if (!whListAllows(r.whClasses, destClass)) {
      discordLog.info(`connection ${r.a} <-> ${r.b} suppressed — dest class "${destClass}" not in the org's class filter`);
      return;
    }
    // Size is derivable only once the type is known (Q003 -> small). A K162 has
    // no known size — show none rather than a misleading default, and fail the
    // size filter open so an unknown hole isn't hidden by it.
    const effSize = known ? ((await whSizeForCode(code)) ?? r.size ?? 'large') : null;
    if (effSize && !whListAllows(r.whSizes, effSize)) {
      discordLog.info(`connection ${r.a} <-> ${r.b} suppressed — size "${effSize}" not in the org's size filter`);
      return;
    }
    // Claim the send atomically: the first broadcast (discord_notified false→true)
    // or the one-time upgrade when the type becomes known (discord_notified_known
    // false→true). Only the row update that actually transitions posts, so
    // concurrent triggers can't double-broadcast the same step.
    const claim = await db.query(
      `UPDATE map_connections
          SET discord_notified = TRUE, discord_notified_known = discord_notified_known OR $2
        WHERE id = $1 AND (discord_notified = FALSE OR (discord_notified_known = FALSE AND $2))`,
      [connId, known]);
    if (claim.rowCount === 0) return; // someone else already claimed this step
    // Choose the embed: a newly revealed k-space exit (HS/LS/NS endpoint whose
    // security is known and at/above the org minimum) that's reachable from the
    // map's home gets the rich routing embed; anything else keeps the plain
    // connection notification. Computing the intel is best-effort — any failure
    // (or an unreachable / home-less exit) falls back to the plain embed so the
    // send still happens.
    try {
      const exit = pickKspaceExit(r);
      if (exit) {
        const intel = await computeExitIntel(mapId, exit.nodeId);
        if (intel) {
          notifyDiscord(r.connectionsWebhook, kspaceExitEmbed({
            exitName: exit.name, exitRegion: exit.region, exitSecurity: exit.security,
            connectedName: exit.connectedName, connectedClass: exit.connectedClass,
            pathNames: intel.pathNames, whJumps: intel.whJumps, gateJumps: intel.gateJumps,
            maxShipSize: intel.maxShipSize,
            hubName: intel.hub?.name ?? null, hubJumps: intel.hub?.jumps ?? null,
            total: intel.total, mapName: r.mapName, actor,
          }));
          return;
        }
      }
    } catch (e) {
      discordLog.warn(`k-space exit intel failed for ${r.a} <-> ${r.b} (falling back to plain embed): ${(e as Error).message}`);
    }
    // Plain embed still carries the nearest trade hub when one endpoint is
    // k-space (the exit you'd travel to) — best-effort, so a route-graph miss
    // just omits the field rather than dropping the whole notification.
    let hub: { name: string; jumps: number } | null = null;
    const hubEve = kspaceHubEve(r);
    if (hubEve != null) {
      try { hub = await nearestTradeHub(hubEve); }
      catch (e) { discordLog.warn(`trade-hub lookup failed for ${r.a} <-> ${r.b}: ${(e as Error).message}`); }
    }
    notifyDiscord(r.connectionsWebhook, connectionEmbed({
      a: r.a, b: r.b, whType: ev.whType || r.whType,
      size: effSize ? (SIZE_LABEL[effSize] ?? effSize) : null,
      hubName: hub?.name ?? null, hubJumps: hub?.jumps ?? null,
      mapName: r.mapName, actor,
    }));
  }).catch((e) => discordLog.warn(`connection dispatch query failed: ${(e as Error).message}`));
}

// Smallest wormhole size across a chain's hops = the largest ship that can make
// the whole trip. Only 'standard' (wormhole) links constrain it; gates/bridges
// are unlimited, so a gates-only chain reports "Any". `size` is the connection's
// stored jump-size class, same value the new-connection notification reports.
const SIZE_RANK: Record<string, number> = { small: 0, medium: 1, large: 2, xl: 3 };
const SIZE_LABEL: Record<string, string> = { small: 'Small', medium: 'Medium', large: 'Large', xl: 'XL' };
function chainMaxSize(sizes: string[]): string {
  let tightest: string | null = null;
  for (const s of sizes) {
    if (!(s in SIZE_RANK)) continue;
    if (tightest === null || SIZE_RANK[s] < SIZE_RANK[tightest]) tightest = s;
  }
  return tightest ? (SIZE_LABEL[tightest] ?? tightest) : 'Any (gates)';
}

// Broadcast a saved wormhole chain. Same gates as the other notifications (org
// webhook + per-map opt-out + region filter) plus the notify_chains toggle. The
// region check uses the chain's endpoint systems.
function dispatchChainSaved(
  meta: MapMeta, mapId: string, route: { name: string; systemIds: string[]; connectionIds: string[] }, actor: string | null,
): void {
  if (!hasOrg(meta)) return; // personal map — never notifies
  const startId = route.systemIds[0];
  const endId   = route.systemIds[route.systemIds.length - 1];
  db.query<{
    startName: string; endName: string; startRegion: string | null; endRegion: string | null;
    mapName: string; mapEnabled: boolean; allRegions: boolean; regions: string[]; notifyChains: boolean;
    sizes: string[]; chainsWebhook: string | null;
  }>(
    `SELECT sn.name AS "startName", en.name AS "endName",
            sn.region_name AS "startRegion", en.region_name AS "endRegion",
            m.name AS "mapName", m.discord_notify AS "mapEnabled",
            ${DISCORD_SETTINGS_COLS},
            COALESCE((SELECT array_agg(c.size)
                        FROM map_connections c
                       WHERE c.id = ANY($4::uuid[]) AND c.connection_type = 'standard'), '{}'::text[]) AS sizes
       FROM maps m
       JOIN map_systems sn ON sn.id = $2
       JOIN map_systems en ON en.id = $3
       ${DISCORD_SETTINGS_JOIN}
      WHERE m.id = $1`,
    [mapId, startId, endId, route.connectionIds],
  ).then(({ rows }) => {
    const r = rows[0];
    if (!r) { discordLog.warn(`chain dispatch: endpoints not found`); return; }
    if (!r.chainsWebhook) { discordLog.info(`chain "${route.name}" suppressed — no chains webhook configured`); return; }
    if (!r.mapEnabled) { discordLog.info(`chain "${route.name}" suppressed — map "${r.mapName}" is excluded from Discord`); return; }
    if (!r.notifyChains) { discordLog.info(`chain "${route.name}" suppressed — chain broadcasts off for this org`); return; }
    if (!regionAllowed(r.allRegions, r.regions, [r.startRegion, r.endRegion])) {
      discordLog.info(`chain "${route.name}" suppressed — neither endpoint region in the org filter`);
      return;
    }
    notifyDiscord(r.chainsWebhook, chainEmbed({
      name:    route.name,
      start:   r.startName,
      end:     r.endName,
      maxSize: chainMaxSize(r.sizes),
      hops:    route.connectionIds.length,
      mapName: r.mapName,
      actor,
    }));
  }).catch((e) => discordLog.warn(`chain dispatch query failed: ${(e as Error).message}`));
}

// Confirms a system UUID actually belongs to the supplied map; prevents
// cross-map IDOR on signature/structure routes that take a systemId param.
async function verifySystemInMap(res: Response, systemId: string, mapId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM map_systems WHERE id = $1 AND map_id = $2`,
    [systemId, mapId],
  );
  if (!rowCount) { res.status(404).json({ error: 'System not found' }); return false; }
  return true;
}

// Confirms a connection belongs to the map (cross-map IDOR guard + malformed-uuid
// crash guard), mirroring verifySystemInMap.
async function verifyConnectionInMap(res: Response, connectionId: string, mapId: string): Promise<boolean> {
  if (!UUID_RE.test(connectionId)) { res.status(404).json({ error: 'Connection not found' }); return false; }
  const { rowCount } = await db.query(
    `SELECT 1 FROM map_connections WHERE id = $1 AND map_id = $2`,
    [connectionId, mapId],
  );
  if (!rowCount) { res.status(404).json({ error: 'Connection not found' }); return false; }
  return true;
}

// ── Maps ──────────────────────────────────────────────────────────────────────

const MAX_MAP_NAME_LEN  = 200;
const MAX_BOOKMARK_FMT_LEN = 200;
const MAX_IMPORT_SYSTEMS     = 500;
const MAX_IMPORT_CONNECTIONS = 2000;

// GET /api/maps
// Resolve the session identity and return the full set of maps the caller can
// see (personal + corp + alliance + shared). Single source for GET /, GET
// /homes, and the closest-systems union route so the three can never drift on
// which maps "belong" to a user.
export async function gatherVisibleMaps(req: Request) {
  const userId         = req.session.userId!;
  const userCorpId     = req.session.userCorpId ?? null;
  const userAllianceId = req.session.userAllianceId ?? null;
  // Personal maps are scoped to the account (owner), so every linked alt sees
  // the same chain. -1 is an impossible owner id (so the clause matches nothing
  // rather than everything) when somehow unauthenticated for ownership.
  const ownerId = (await resolveOwnerId(req)) ?? -1;
  // Need the caller's EVE character id to match against map_shares.
  // One small query up front beats a CTE — there's only one user row.
  const { rows: meRows } = await db.query<{ characterId: number }>(
    `SELECT character_id AS "characterId" FROM users WHERE id = $1`,
    [userId],
  );
  const callerChar = meRows[0]?.characterId ?? null;
  // Visibility query lives in the shared map-read module so the external
  // /api/v1 list returns the identical set.
  return listVisibleMaps({ userId, ownerId, userCorpId, userAllianceId, callerChar });
}

// Just the ids of the caller's visible maps — used to scope map-based route
// overlays (wormhole/Ansiblex chains) to every map the user can see, not one
// active tab. Already access-filtered, so callers need no further getMapAccess.
export async function visibleMapIds(req: Request): Promise<string[]> {
  const rows = await gatherVisibleMaps(req);
  return rows.map((m: { id: string }) => m.id);
}

mapsRouter.get('/', async (req, res) => {
  const userCorpId     = req.session.userCorpId ?? null;
  const userAllianceId = req.session.userAllianceId ?? null;
  const rows = await gatherVisibleMaps(req);

  // Count corp maps for the user's own corp (the per-corp limit applies to
  // each corp independently — Corp A's slots are separate from Corp B's).
  const corpMapCount = (config.corpMode || config.allianceMode) && userCorpId
    ? (await db.query(`SELECT 1 FROM maps WHERE corp_id = $1`, [userCorpId])).rowCount ?? 0
    : 0;
  const allianceMapCount = config.allianceMode && userAllianceId
    ? (await db.query(`SELECT 1 FROM maps WHERE alliance_id = $1`, [userAllianceId])).rowCount ?? 0
    : 0;

  res.json({
    maps: rows,
    maxMaps: config.maxUserMaps,
    maxCorpMaps: config.maxCorpMaps,
    corpMapCount,
    maxAllianceMaps: config.maxAllianceMaps,
    allianceMapCount,
  });
});

// Home systems flagged across every map the caller can see. Powers the
// Closest Systems pane's auto-home rows, which are per-user (they must not
// change when the active map tab does). Deduped by eve system id — the same
// home flagged on two maps surfaces once. Registered before GET /:mapId so the
// literal path wins the match.
mapsRouter.get('/homes', async (req, res) => {
  const mapIds = await visibleMapIds(req);
  if (mapIds.length === 0) return res.json({ homes: [] });
  const { rows } = await db.query<{ eveSystemId: number; name: string }>(
    `SELECT DISTINCT ON (ms.eve_system_id)
            ms.eve_system_id AS "eveSystemId", ms.name
       FROM map_systems ms
       JOIN maps m ON m.id = ms.map_id
      WHERE ms.map_id = ANY($1::uuid[])
        AND ms.is_home = TRUE
        AND ms.eve_system_id IS NOT NULL
      ORDER BY ms.eve_system_id, m.name`,
    [mapIds],
  );
  res.json({ homes: rows });
});

// POST /api/maps
mapsRouter.post('/', async (req, res) => {
  // Scope is exclusive: alliance takes precedence over corp when both flags are
  // sent. Alliance maps are alliance_admin-only; corp maps need full/admin.
  const isAllianceMap = config.allianceMode && req.body.isAllianceMap === true;
  const isCorpMap     = !isAllianceMap && (config.corpMode || config.allianceMode) && req.body.isCorpMap === true;
  const role          = req.session.role ?? 'readonly';

  // Personal map creation is open to every role — they're scoped to the
  // individual user, so role gating only matters for shared (corp/alliance) maps.
  if (isAllianceMap) {
    if (!isAllianceAdmin(role)) {
      res.status(403).json({ error: 'Alliance map creation requires the alliance admin role' });
      return;
    }
    if (!req.session.userAllianceId) {
      res.status(403).json({ error: 'Cannot create alliance map: user has no alliance affiliation' });
      return;
    }
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE alliance_id = $1`,
      [req.session.userAllianceId],
    );
    if ((rowCount ?? 0) >= config.maxAllianceMaps) {
      res.status(403).json({ error: 'Maximum alliance maps reached' });
      return;
    }
  } else if (isCorpMap) {
    if (role !== 'full' && !isAdmin(role)) {
      res.status(403).json({ error: 'Corp map creation requires full-edit or admin role' });
      return;
    }
    if (!req.session.userCorpId) {
      res.status(403).json({ error: 'Cannot create corp map: user has no corp affiliation' });
      return;
    }
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE corp_id = $1`,
      [req.session.userCorpId],
    );
    if ((rowCount ?? 0) >= config.maxCorpMaps) {
      res.status(403).json({ error: 'Maximum corp maps reached' });
      return;
    }
  } else {
    // Per-account personal-map cap, counted by owner. Enforced only here at
    // creation, so an account that merged past the cap keeps its maps and just
    // can't make new ones until it deletes back under.
    const ownerId = await resolveOwnerId(req);
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE owner_id = $1 AND corp_id IS NULL AND alliance_id IS NULL`,
      [ownerId],
    );
    if ((rowCount ?? 0) >= config.maxUserMaps) {
      res.status(403).json({ error: 'Maximum maps reached' });
      return;
    }
  }

  const name       = String(req.body.name ?? 'New Map').slice(0, MAX_MAP_NAME_LEN);
  const corpId     = isCorpMap ? (req.session.userCorpId ?? null) : null;
  const allianceId = isAllianceMap ? (req.session.userAllianceId ?? null) : null;
  const ownerId    = await resolveOwnerId(req);
  // Map-level "Don't track K-space" only applies to corp/alliance maps; force
  // false on personal maps (they keep the per-user nexum.tracking.skipKspace).
  const skipKspace = req.body.skipKspace === true && (isCorpMap || isAllianceMap);

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, owner_id, name, corp_id, alliance_id, skip_kspace) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.session.userId, ownerId, name, corpId, allianceId, skipKspace],
  );
  res.status(201).json({ id: rows[0].id });
});

// POST /api/maps/:mapId/copy — duplicate a map the caller can read into a new
// map. A read-only corp/alliance map can't be copied. The copy's SCOPE is chosen
// by the caller (isCorpMap / isAllianceMap) independent of the source's scope —
// e.g. copy an alliance map into a new corp map — subject to the same role,
// affiliation and quota rules as POST /. Body: { name, isCorpMap?, isAllianceMap?,
// include: { notes, signatures, structures, anomalies } }.
mapsRouter.post('/:mapId/copy', async (req, res) => {
  const sourceMapId = req.params.mapId;
  const access = await getMapAccess(sourceMapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  // A map that reached the caller via a map_shares grant (someone else's map,
  // shared with them) can only be copied by its owner — a recipient can't fork it.
  if (access.accessKind === 'shared') {
    res.status(403).json({ error: 'A map shared with you can only be copied by its owner' });
    return;
  }
  if ((access.accessKind === 'corp_member' || access.accessKind === 'alliance_member') && authUser(req).role === 'readonly') {
    res.status(403).json({ error: 'Read-only corp/alliance maps cannot be copied' });
    return;
  }

  // Target scope — exclusive, alliance wins over corp, same rules as POST /.
  const role          = req.session.role ?? 'readonly';
  const isAllianceMap = config.allianceMode && req.body.isAllianceMap === true;
  const isCorpMap     = !isAllianceMap && (config.corpMode || config.allianceMode) && req.body.isCorpMap === true;

  if (isAllianceMap) {
    if (!isAllianceAdmin(role)) {
      res.status(403).json({ error: 'Alliance map creation requires the alliance admin role' }); return;
    }
    if (!req.session.userAllianceId) {
      res.status(403).json({ error: 'Cannot create alliance map: user has no alliance affiliation' }); return;
    }
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE alliance_id = $1`, [req.session.userAllianceId]);
    if ((rowCount ?? 0) >= config.maxAllianceMaps) { res.status(403).json({ error: 'Maximum alliance maps reached' }); return; }
  } else if (isCorpMap) {
    if (role !== 'full' && !isAdmin(role)) {
      res.status(403).json({ error: 'Corp map creation requires full-edit or admin role' }); return;
    }
    if (!req.session.userCorpId) {
      res.status(403).json({ error: 'Cannot create corp map: user has no corp affiliation' }); return;
    }
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE corp_id = $1`, [req.session.userCorpId]);
    if ((rowCount ?? 0) >= config.maxCorpMaps) { res.status(403).json({ error: 'Maximum corp maps reached' }); return; }
  } else {
    const oid = await resolveOwnerId(req);
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE owner_id = $1 AND corp_id IS NULL AND alliance_id IS NULL`, [oid],
    );
    if ((rowCount ?? 0) >= config.maxUserMaps) { res.status(403).json({ error: 'Maximum maps reached' }); return; }
  }

  const name = String(req.body.name ?? '').trim().slice(0, MAX_MAP_NAME_LEN);
  if (!name) { res.status(400).json({ error: 'Name is required' }); return; }

  const ownerId    = await resolveOwnerId(req);
  const corpId     = isCorpMap     ? (req.session.userCorpId ?? null)     : null;
  const allianceId = isAllianceMap ? (req.session.userAllianceId ?? null) : null;

  const inc = (req.body.include ?? {}) as Record<string, unknown>;
  try {
    const newId = await copyMap({
      sourceMapId, name, ownerId, userId: req.session.userId!, corpId, allianceId,
      include: {
        notes:      inc.notes === true,
        signatures: inc.signatures === true,
        structures: inc.structures === true,
        anomalies:  inc.anomalies === true,
      },
    });
    res.status(201).json({ id: newId });
  } catch (err) {
    log.error('Map copy failed:', err);
    res.status(500).json({ error: 'Map copy failed' });
  }
});

// POST /api/maps/from-region — create a new map pre-populated with an entire
// K-space region: every system positioned by its EVE coordinates (Dotlan-style
// projection of x/z) plus all intra-region stargate links. Blank-map creation
// stays on POST /api/maps; this is only the seeded path. See
// region_map_feature.md.
mapsRouter.post('/from-region', async (req, res) => {
  const body     = req.body as { regionId?: unknown; name?: unknown; isCorpMap?: unknown; isAllianceMap?: unknown; skipKspace?: unknown };
  const regionId = Number(body.regionId);
  if (!Number.isInteger(regionId)) { res.status(400).json({ error: 'regionId is required' }); return; }

  const isAllianceMap = config.allianceMode && body.isAllianceMap === true;
  const isCorpMap     = !isAllianceMap && (config.corpMode || config.allianceMode) && body.isCorpMap === true;
  const role          = req.session.role ?? 'readonly';

  // Quota + role — mirrors POST /api/maps and /import.
  if (isAllianceMap) {
    if (!isAllianceAdmin(role)) {
      res.status(403).json({ error: 'Alliance map creation requires the alliance admin role' }); return;
    }
    if (!req.session.userAllianceId) {
      res.status(403).json({ error: 'Cannot create alliance map: user has no alliance affiliation' }); return;
    }
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE alliance_id = $1`, [req.session.userAllianceId]);
    if ((rowCount ?? 0) >= config.maxAllianceMaps) { res.status(403).json({ error: 'Maximum alliance maps reached' }); return; }
  } else if (isCorpMap) {
    if (role !== 'full' && !isAdmin(role)) {
      res.status(403).json({ error: 'Corp map creation requires full-edit or admin role' }); return;
    }
    if (!req.session.userCorpId) {
      res.status(403).json({ error: 'Cannot create corp map: user has no corp affiliation' }); return;
    }
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE corp_id = $1`, [req.session.userCorpId]);
    if ((rowCount ?? 0) >= config.maxCorpMaps) { res.status(403).json({ error: 'Maximum corp maps reached' }); return; }
  } else {
    const oid = await resolveOwnerId(req);
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE owner_id = $1 AND corp_id IS NULL AND alliance_id IS NULL`, [oid]);
    if ((rowCount ?? 0) >= config.maxUserMaps) { res.status(403).json({ error: 'Maximum maps reached' }); return; }
  }

  // Region systems (with coordinates) + region name.
  const [sysRes, regionRes] = await Promise.all([
    db.query<{
      id: number; name: string; systemClass: string | null; effect: string | null;
      statics: string[]; x2: number | null; y2: number | null;
    }>(
      `SELECT id, name, class AS "systemClass", effect, statics,
              pos2d_x AS "x2", pos2d_y AS "y2"
         FROM solar_systems WHERE region_id = $1`,
      [regionId],
    ),
    db.query<{ name: string }>(`SELECT name FROM map_regions WHERE id = $1`, [regionId]),
  ]);

  if (sysRes.rows.length === 0)                  { res.status(404).json({ error: 'Region not found or has no systems' }); return; }
  if (sysRes.rows.length > MAX_IMPORT_SYSTEMS)   { res.status(413).json({ error: `Region too large (max ${MAX_IMPORT_SYSTEMS} systems)` }); return; }
  if (sysRes.rows.some((s) => s.x2 === null || s.y2 === null)) {
    res.status(503).json({ error: 'Region coordinates not seeded yet — run `npm run backfill-coords` (or re-run setup-db).' });
    return;
  }

  const regionName = regionRes.rows[0]?.name ?? 'Region';
  const mapName    = String(typeof body.name === 'string' && body.name.trim() ? body.name : regionName).slice(0, MAX_MAP_NAME_LEN);

  // Lay out from CCP's 2D star-map projection (position2D) so stargate-connected
  // systems sit adjacent the way the in-game map / Dotlan show them. Scale is
  // derived from the median nearest-neighbour distance → a target on-screen gap,
  // so typical adjacent systems land ~TARGET_GAP px apart regardless of region.
  // Y is flipped so north is up.
  const pts = sysRes.rows.map((s) => ({ x: s.x2 as number, y: s.y2 as number }));
  const minX = Math.min(...pts.map((p) => p.x));
  const maxY = Math.max(...pts.map((p) => p.y));

  const TARGET_GAP = 220; // px between typical adjacent systems (≈ node width + a 2-square gap)
  let medianNN = 1;
  if (pts.length > 1) {
    const nn = pts.map((a, i) => {
      let best = Infinity;
      for (let j = 0; j < pts.length; j++) {
        if (j === i) continue;
        const dx = a.x - pts[j].x, dy = a.y - pts[j].y;
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    }).sort((a, b) => a - b);
    medianNN = nn[Math.floor(nn.length / 2)] || 1;
  }
  const scale = TARGET_GAP / (medianNN > 0 ? medianNN : 1);

  // Project to screen coordinates (flip Y for north-up).
  const coords = sysRes.rows.map((s) => ({
    x: ((s.x2 as number) - minX) * scale,
    y: (maxY - (s.y2 as number)) * scale,
  }));

  // Enforce a minimum gap between nodes. System nodes are much wider than they
  // are tall, so a single circular distance can't space both axes — it leaves
  // horizontal neighbours touching while vertical ones look fine. Instead we
  // separate their *bounding boxes* (positions are top-left corners), keeping at
  // least GRID*2 (two snap-grid squares) of clear space on whichever axis two
  // boxes are closest, resolving each overlap along its shallower axis. Only the
  // too-close pairs move; the rest of the projected layout is preserved.
  const GRID = 20;          // matches the canvas snapGrid={[20,20]}
  const NODE_W = 200;       // assumed rendered node width  (min-width 150 + padding + content)
  const NODE_H = 120;       // assumed rendered node height
  const MIN_X = NODE_W + GRID * 2; // ≥2 grid squares of horizontal gap
  const MIN_Y = NODE_H + GRID * 2; // ≥2 grid squares of vertical gap
  const n = coords.length;
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = coords[j].x - coords[i].x;
        const dy = coords[j].y - coords[i].y;
        const ox = MIN_X - Math.abs(dx); // >0 ⇒ boxes overlap (incl. gap) in X
        const oy = MIN_Y - Math.abs(dy); // >0 ⇒ boxes overlap (incl. gap) in Y
        if (ox <= 0 || oy <= 0) continue; // already clear on at least one axis
        // Push apart along the shallower axis (smallest move that separates them).
        if (ox <= oy) {
          const s = (dx < 0 ? -1 : 1) * (ox / 2); // dx===0 → push +x
          coords[i].x -= s; coords[j].x += s;
        } else {
          const s = (dy < 0 ? -1 : 1) * (oy / 2); // dy===0 → push +y
          coords[i].y -= s; coords[j].y += s;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const ownerId = await resolveOwnerId(req);
    // K-space tracking policy only applies to corp/alliance maps; false otherwise.
    const skipKspace = body.skipKspace === true && (isCorpMap || isAllianceMap);
    const mapRes = await client.query<{ id: string }>(
      `INSERT INTO maps (user_id, owner_id, name, corp_id, alliance_id, skip_kspace) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.session.userId, ownerId, mapName,
       isCorpMap ? (req.session.userCorpId ?? null) : null,
       isAllianceMap ? (req.session.userAllianceId ?? null) : null,
       skipKspace],
    );
    const mapId = mapRes.rows[0].id;

    // Insert systems; remember eve_system_id → new UUID for wiring connections.
    const idByEve = new Map<number, string>();
    const sysCols = 15;
    const sysPh: string[] = []; const sysVals: unknown[] = [];
    sysRes.rows.forEach((s, idx) => {
      const newId = crypto.randomUUID();
      idByEve.set(s.id, newId);
      const { x, y } = coords[idx];
      const base = sysVals.length;
      sysPh.push(`(${Array.from({ length: sysCols }, (_, i) => `$${base + i + 1}`).join(',')})`);
      sysVals.push(
        newId, mapId, s.id, s.name, s.systemClass ?? 'unknown',
        s.effect ?? 'none', s.statics ?? [], regionName, null,
        x, y, 'unknown', false, false, '',
      );
    });
    await client.query(
      `INSERT INTO map_systems
         (id, map_id, eve_system_id, name, system_class, effect, statics, region_name, npc_type,
          position_x, position_y, status, is_home, locked, notes)
       VALUES ${sysPh.join(',')}`,
      sysVals,
    );

    // Intra-region stargates → connections. Each gate has a reverse twin, so
    // dedup by undirected pair; drop self-loops.
    const eveIds = [...idByEve.keys()];
    const gateRes = await client.query<{ a: number; b: number }>(
      `SELECT system_id AS a, destination_system_id AS b
         FROM map_stargates
        WHERE system_id = ANY($1::int[]) AND destination_system_id = ANY($1::int[])`,
      [eveIds],
    );
    const seen = new Set<string>();
    const connPh: string[] = []; const connVals: unknown[] = [];
    for (const g of gateRes.rows) {
      const src = idByEve.get(g.a);
      const tgt = idByEve.get(g.b);
      if (!src || !tgt || src === tgt) continue;
      const key = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = connVals.length;
      connPh.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
      // These come straight from map_stargates, so they ARE in-game gates.
      connVals.push(crypto.randomUUID(), mapId, src, tgt, 'gate', 'large');
    }
    if (connPh.length > 0) {
      await client.query(
        `INSERT INTO map_connections (id, map_id, source_id, target_id, connection_type, size)
         VALUES ${connPh.join(',')}`,
        connVals,
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: mapId, systems: sysRes.rows.length, connections: connPh.length });
  } catch (err) {
    await client.query('ROLLBACK');
    log.error('map from-region failed:', err);
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/maps/import
mapsRouter.post('/import', async (req, res) => {
  const importBody     = req.body as Record<string, unknown>;
  const isAllianceImport = config.allianceMode && importBody.isAllianceMap === true;
  const isCorpImport     = !isAllianceImport && (config.corpMode || config.allianceMode) && importBody.isCorpMap === true;
  const role             = req.session.role ?? 'readonly';

  // Quota check against the matching tier — importing a corp/alliance map counts
  // against the corresponding cap, importing a personal map counts against
  // MAX_USER_MAPS. Personal imports are open to every role; corp imports need
  // full/admin; alliance imports need alliance_admin.
  if (isAllianceImport) {
    if (!isAllianceAdmin(role)) {
      res.status(403).json({ error: 'Alliance map import requires the alliance admin role' });
      return;
    }
    if (!req.session.userAllianceId) {
      res.status(403).json({ error: 'Cannot import alliance map: user has no alliance affiliation' });
      return;
    }
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE alliance_id = $1`, [req.session.userAllianceId]);
    if ((rowCount ?? 0) >= config.maxAllianceMaps) {
      res.status(403).json({ error: 'Maximum alliance maps reached' });
      return;
    }
  } else if (isCorpImport) {
    if (role !== 'full' && !isAdmin(role)) {
      res.status(403).json({ error: 'Corp map import requires full-edit or admin role' });
      return;
    }
    if (!req.session.userCorpId) {
      res.status(403).json({ error: 'Cannot import corp map: user has no corp affiliation' });
      return;
    }
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE corp_id = $1`,
      [req.session.userCorpId],
    );
    if ((rowCount ?? 0) >= config.maxCorpMaps) {
      res.status(403).json({ error: 'Maximum corp maps reached' });
      return;
    }
  } else {
    const oid = await resolveOwnerId(req);
    const { rowCount } = await db.query(
      `SELECT 1 FROM maps WHERE owner_id = $1 AND corp_id IS NULL AND alliance_id IS NULL`,
      [oid],
    );
    if ((rowCount ?? 0) >= config.maxUserMaps) {
      res.status(403).json({ error: 'Maximum maps reached' });
      return;
    }
  }

  const { name, systems = [], connections = [], skipKspace } = req.body as {
    name?: string;
    systems?: Array<Record<string, unknown>>;
    connections?: Array<Record<string, unknown>>;
    skipKspace?: boolean;
  };

  if (!Array.isArray(systems) || !Array.isArray(connections)) {
    res.status(400).json({ error: 'systems and connections must be arrays' });
    return;
  }
  if (systems.length > MAX_IMPORT_SYSTEMS) {
    res.status(413).json({ error: `Too many systems (max ${MAX_IMPORT_SYSTEMS})` });
    return;
  }
  if (connections.length > MAX_IMPORT_CONNECTIONS) {
    res.status(413).json({ error: `Too many connections (max ${MAX_IMPORT_CONNECTIONS})` });
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const importName = String(name ?? 'Imported Map').slice(0, MAX_MAP_NAME_LEN);
    const ownerId = await resolveOwnerId(req);
    // K-space tracking policy only applies to corp/alliance maps; false otherwise.
    const importSkipKspace = skipKspace === true && (isCorpImport || isAllianceImport);
    const mapRes = await client.query<{ id: string }>(
      `INSERT INTO maps (user_id, owner_id, name, corp_id, alliance_id, skip_kspace) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.session.userId, ownerId, importName,
       isCorpImport ? (req.session.userCorpId ?? null) : null,
       isAllianceImport ? (req.session.userAllianceId ?? null) : null,
       importSkipKspace],
    );
    const mapId = mapRes.rows[0].id;

    // Remap old system UUIDs → fresh ones to avoid any collisions on re-import.
    // Build the rows up first, then bulk-insert in one round-trip each.
    // Dedupe input by eve_system_id — a legacy export may carry the same
    // K-space system twice. First occurrence wins; later refs get aliased
    // to the same new UUID so connections that pointed at the duplicate
    // re-attach correctly to the survivor.
    const idMap = new Map<string, string>();
    if (systems.length > 0) {
      // Batch-resolve names → eve_system_id for any row that arrived without
      // an ID. One SELECT amortised over the whole import beats N round-trips.
      const namesNeedingResolve = [...new Set(
        systems
          .filter((s) => s.eveSystemId == null && typeof s.name === 'string' && s.name)
          .map((s) => s.name as string),
      )];
      const nameToId = new Map<string, number>();
      if (namesNeedingResolve.length > 0) {
        const { rows } = await client.query<{ id: number; name: string }>(
          `SELECT id, name FROM solar_systems WHERE name = ANY($1::text[])`,
          [namesNeedingResolve],
        );
        for (const r of rows) nameToId.set(r.name, r.id);
      }

      const eveToNewId = new Map<number, string>();
      const sysCols = 15;
      const sysPlaceholders: string[] = [];
      const sysValues: unknown[] = [];
      for (const sys of systems) {
        const eveId = (sys.eveSystemId as number | null | undefined)
          ?? (typeof sys.name === 'string' ? nameToId.get(sys.name) ?? null : null);
        if (eveId != null && eveToNewId.has(eveId)) {
          // Already inserted for this map — alias the old UUID to the winner.
          idMap.set(String(sys.id), eveToNewId.get(eveId)!);
          continue;
        }
        const newId = crypto.randomUUID();
        idMap.set(String(sys.id), newId);
        if (eveId != null) eveToNewId.set(eveId, newId);
        const pos = (sys.position as { x: number; y: number }) ?? { x: 0, y: 0 };
        const base = sysValues.length;
        sysPlaceholders.push(`(${Array.from({ length: sysCols }, (_, i) => `$${base + i + 1}`).join(',')})`);
        sysValues.push(
          newId, mapId, eveId, sys.name, sys.systemClass,
          sys.effect ?? 'none', sys.statics ?? [], sys.regionName ?? null, sys.npcType ?? null,
          pos.x, pos.y, sys.status ?? 'unknown', sys.isHome ?? false, sys.locked ?? false, sys.notes ?? '',
        );
      }
      if (sysPlaceholders.length > 0) {
        await client.query(
          `INSERT INTO map_systems
             (id, map_id, eve_system_id, name, system_class, effect, statics, region_name, npc_type,
              position_x, position_y, status, is_home, locked, notes)
           VALUES ${sysPlaceholders.join(',')}`,
          sysValues,
        );
      }
    }

    // After eve_system_id dedup above, two distinct old UUIDs may alias to
    // the same new UUID. Drop self-loops, and dedupe by undirected pair so
    // we don't insert two connections between the same pair of nodes.
    const seenPair = new Set<string>();
    const validConns = connections
      .map((conn) => {
        const srcId = idMap.get(String(conn.sourceId));
        const tgtId = idMap.get(String(conn.targetId));
        if (!srcId || !tgtId || srcId === tgtId) return null;
        const key = srcId < tgtId ? `${srcId}|${tgtId}` : `${tgtId}|${srcId}`;
        if (seenPair.has(key)) return null;
        seenPair.add(key);
        return { conn, srcId, tgtId };
      })
      .filter((c): c is { conn: Record<string, unknown>; srcId: string; tgtId: string } => c !== null);

    if (validConns.length > 0) {
      const connCols = 10;
      const connPlaceholders: string[] = [];
      const connValues: unknown[] = [];
      for (const { conn, srcId, tgtId } of validConns) {
        const base = connValues.length;
        connPlaceholders.push(`(${Array.from({ length: connCols }, (_, i) => `$${base + i + 1}`).join(',')})`);
        connValues.push(
          crypto.randomUUID(), mapId, srcId, tgtId,
          conn.sourceHandle ?? null, conn.targetHandle ?? null,
          conn.connectionType ?? 'standard', conn.massStatus ?? null,
          conn.timeStatus ?? null, conn.size ?? 'large',
        );
      }
      await client.query(
        `INSERT INTO map_connections
           (id, map_id, source_id, target_id, source_handle, target_handle,
            connection_type, mass_status, time_status, size)
         VALUES ${connPlaceholders.join(',')}`,
        connValues,
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: mapId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ── Wanderer import ─────────────────────────────────────────────────────────
// Import a map exported from Wanderer (the other EVE wormhole mapper). Its export
// gives only EVE system ids + a coarse layout + numeric mass/time/size codes. We
// enrich each system's name/class/effect/statics/region from our SDE, classify
// each connection as gate vs wormhole from map_stargates (Wanderer doesn't export
// that), de-overlap the layout for our larger nodes, and create a personal map.
// Not recoverable from the export: wormhole types (N062/K162) and signatures.
const W_MASS: Record<number, string> = { 0: 'stable', 1: 'destabilized', 2: 'critical' };
const W_TIME: Record<number, string> = { 0: 'fresh', 1: 'eol' };
const W_SIZE: Record<number, string> = { 0: 'small', 1: 'medium', 2: 'large', 3: 'xl' };

interface WSystem { id?: unknown; position?: { x?: unknown; y?: unknown }; locked?: unknown; tag?: unknown; description?: unknown }
interface WConn   { source?: unknown; target?: unknown; mass_status?: unknown; time_status?: unknown; ship_size_type?: unknown }

// Push overlapping node boxes apart (our nodes are far bigger than Wanderer's),
// preserving relative layout. Same idea as the region seeder.
function deOverlapCoords(coords: Array<{ x: number; y: number }>): void {
  const MIN_X = 240, MIN_Y = 160;
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (let i = 0; i < coords.length; i++) for (let j = i + 1; j < coords.length; j++) {
      const dx = coords[j].x - coords[i].x, dy = coords[j].y - coords[i].y;
      const ox = MIN_X - Math.abs(dx), oy = MIN_Y - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      if (ox <= oy) { const s = (dx < 0 ? -1 : 1) * (ox / 2); coords[i].x -= s; coords[j].x += s; }
      else          { const s = (dy < 0 ? -1 : 1) * (oy / 2); coords[i].y -= s; coords[j].y += s; }
      moved = true;
    }
    if (!moved) break;
  }
}

mapsRouter.post('/import/wanderer', async (req, res) => {
  const body = req.body as { name?: unknown; systems?: unknown; connections?: unknown };
  const systems     = Array.isArray(body.systems) ? (body.systems as WSystem[]) : null;
  const connections = Array.isArray(body.connections) ? (body.connections as WConn[]) : [];
  if (!systems)                                   { res.status(400).json({ error: 'systems must be an array' }); return; }
  if (systems.length > MAX_IMPORT_SYSTEMS)        { res.status(413).json({ error: `Too many systems (max ${MAX_IMPORT_SYSTEMS})` }); return; }
  if (connections.length > MAX_IMPORT_CONNECTIONS) { res.status(413).json({ error: `Too many connections (max ${MAX_IMPORT_CONNECTIONS})` }); return; }

  // v1 imports to a PERSONAL map — enforce that scope's quota.
  const oid = await resolveOwnerId(req);
  const quota = await db.query(`SELECT 1 FROM maps WHERE owner_id = $1 AND corp_id IS NULL AND alliance_id IS NULL`, [oid]);
  if ((quota.rowCount ?? 0) >= config.maxUserMaps) { res.status(403).json({ error: 'Maximum maps reached' }); return; }

  const eveIds = [...new Set(systems.map((s) => Number(s.id)).filter((n) => Number.isInteger(n) && n > 0))];
  if (eveIds.length === 0) { res.status(400).json({ error: 'No valid EVE system ids in the file' }); return; }

  // Enrich from the SDE; unknown ids (Abyssal, bad data) are skipped.
  const { rows: sde } = await db.query<{ id: number; name: string; systemClass: string | null; effect: string | null; statics: string[]; regionName: string | null }>(
    `SELECT s.id, s.name, s.class AS "systemClass", s.effect, s.statics, r.name AS "regionName"
       FROM solar_systems s LEFT JOIN map_regions r ON r.id = s.region_id
      WHERE s.id = ANY($1::int[])`,
    [eveIds],
  );
  const sdeById = new Map(sde.map((r) => [r.id, r]));

  // In-game stargate pairs among the imported systems → 'gate'; the rest 'standard'.
  const { rows: gates } = await db.query<{ a: number; b: number }>(
    `SELECT system_id AS a, destination_system_id AS b FROM map_stargates
      WHERE system_id = ANY($1::int[]) AND destination_system_id = ANY($1::int[])`,
    [eveIds],
  );
  const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const gatePairs = new Set(gates.map((g) => pairKey(g.a, g.b)));

  // Keep only systems we could enrich; carry their Wanderer layout + fields.
  const kept = systems
    .map((s) => ({ s, eve: Number(s.id) }))
    .filter(({ eve }) => Number.isInteger(eve) && sdeById.has(eve));
  if (kept.length === 0) { res.status(400).json({ error: 'None of the systems were recognised (not in the EVE SDE)' }); return; }
  const coords = kept.map(({ s }) => ({ x: Number(s.position?.x) || 0, y: Number(s.position?.y) || 0 }));
  deOverlapCoords(coords);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const name = String(typeof body.name === 'string' && body.name.trim() ? body.name : 'Imported from Wanderer').slice(0, MAX_MAP_NAME_LEN);
    const mapRes = await client.query<{ id: string }>(
      `INSERT INTO maps (user_id, owner_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [req.session.userId, oid, name],
    );
    const mapId = mapRes.rows[0].id;

    // Systems.
    const idByEve = new Map<number, string>();
    const SYSCOLS = 16;
    const sysPh: string[] = []; const sysVals: unknown[] = [];
    kept.forEach(({ s, eve }, i) => {
      const info = sdeById.get(eve)!;
      const newId = crypto.randomUUID();
      idByEve.set(eve, newId);
      const base = sysVals.length;
      sysPh.push(`(${Array.from({ length: SYSCOLS }, (_, k) => `$${base + k + 1}`).join(',')})`);
      sysVals.push(
        newId, mapId, eve, info.name, info.systemClass ?? 'unknown',
        info.effect ?? 'none', info.statics ?? [], info.regionName ?? null, null,
        coords[i].x, coords[i].y, 'unknown', false, s.locked === true,
        typeof s.description === 'string' ? s.description.slice(0, 2000) : '',
        typeof s.tag === 'string' ? s.tag.slice(0, 50) : null,
      );
    });
    if (sysPh.length > 0) {
      await client.query(
        `INSERT INTO map_systems
           (id, map_id, eve_system_id, name, system_class, effect, statics, region_name, npc_type,
            position_x, position_y, status, is_home, locked, notes, tag)
         VALUES ${sysPh.join(',')}`,
        sysVals,
      );
    }

    // Connections — only where both endpoints survived; dedup undirected pair.
    const seen = new Set<string>();
    const CONNCOLS = 8;
    const connPh: string[] = []; const connVals: unknown[] = [];
    for (const c of connections) {
      const a = Number(c.source), b = Number(c.target);
      const src = idByEve.get(a), tgt = idByEve.get(b);
      if (!src || !tgt || src === tgt) continue;
      const key = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const type = gatePairs.has(pairKey(a, b)) ? 'gate' : 'standard';
      const base = connVals.length;
      connPh.push(`(${Array.from({ length: CONNCOLS }, (_, k) => `$${base + k + 1}`).join(',')})`);
      connVals.push(
        crypto.randomUUID(), mapId, src, tgt, type,
        W_MASS[Number(c.mass_status)] ?? 'stable',
        W_TIME[Number(c.time_status)] ?? 'fresh',
        W_SIZE[Number(c.ship_size_type)] ?? 'large',
      );
    }
    if (connPh.length > 0) {
      await client.query(
        `INSERT INTO map_connections
           (id, map_id, source_id, target_id, connection_type, mass_status, time_status, size)
         VALUES ${connPh.join(',')}`,
        connVals,
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: mapId, imported: { systems: sysPh.length, connections: connPh.length, skipped: systems.length - kept.length } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Merge a source system note into a destination note. Destination is truth:
// fill it if empty, otherwise append the source note under a divider so
// nothing is lost. Returns the new note string, or null when no change is
// needed (source empty, identical, or already contained).
function mergeSystemNote(destNote: string, srcNote: string, srcMapName: string): string | null {
  const d = (destNote ?? '').trim();
  const s = (srcNote ?? '').trim();
  if (!s) return null;
  if (!d) return srcNote;
  if (d === s || d.includes(s)) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  return `${destNote}\n\n--- merged from "${srcMapName}" (${stamp}) ---\n${srcNote}`;
}

// POST /api/maps/:mapId/merge  — fold a source map's contents into this
// (destination) map. Destination is the source of truth: matched systems keep
// their fields; only missing systems / links, and (per include flags) sigs,
// structures, and notes are added or merged. Single transaction. Corp maps on
// either side produce an admin audit row. See map_merge_feature.md.
mapsRouter.post('/:mapId/merge', async (req, res) => {
  const destId = req.params.mapId;
  const body   = req.body as {
    sourceId?: string;
    include?:  { signatures?: boolean; structures?: boolean; notes?: boolean };
  };
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : '';
  // Filters default ON — the modal always sends explicit booleans, but a
  // missing flag should include rather than silently drop data.
  const include = {
    signatures: body.include?.signatures !== false,
    structures: body.include?.structures !== false,
    notes:      body.include?.notes      !== false,
  };

  if (!sourceId)               { res.status(400).json({ error: 'sourceId is required' }); return; }
  if (sourceId === destId)     { res.status(400).json({ error: 'Source and destination must be different maps' }); return; }
  if (!UUID_RE.test(sourceId)) { res.status(404).json({ error: 'Source map not found' }); return; }

  // Destination needs full write (role + lock). Source needs read access.
  const destAccess = await requireMapWrite(res, destId, req);
  if (!destAccess) return;
  const srcAccess = await getMapAccess(sourceId, req);
  if (!srcAccess) { res.status(404).json({ error: 'Source map not found' }); return; }

  // Names + owners (+ merge opt-in flags) for both maps in one round-trip —
  // for the corp source/destination gates and the audit entries.
  const metaRes = await db.query<{
    id: string; name: string; user_id: number; owner_char: number;
    corp_id: number | null; allow_as_merge_source: boolean; allow_as_merge_destination: boolean;
  }>(
    `SELECT m.id, m.name, m.user_id, u.character_id AS owner_char,
            m.corp_id, m.allow_as_merge_source, m.allow_as_merge_destination
       FROM maps m JOIN users u ON u.id = m.user_id
      WHERE m.id = ANY($1::uuid[])`,
    [[sourceId, destId]],
  );
  const srcMeta  = metaRes.rows.find((r) => r.id === sourceId);
  const destMeta = metaRes.rows.find((r) => r.id === destId);
  if (!srcMeta || !destMeta) { res.status(404).json({ error: 'Map not found' }); return; }

  // A corp map may only be a merge *source* when explicitly enabled.
  if (srcMeta.corp_id !== null && !srcMeta.allow_as_merge_source) {
    res.status(403).json({ error: 'This corp map is not enabled as a merge source' });
    return;
  }
  // …and only a merge *destination* when explicitly enabled.
  if (destMeta.corp_id !== null && !destMeta.allow_as_merge_destination) {
    res.status(403).json({ error: 'This corp map is not enabled as a merge destination' });
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // ── Load both sides ─────────────────────────────────────────────────
    // Sequential awaits, not Promise.all: these all run on the ONE pooled
    // transaction client, which node-pg already serialises — and the concurrent
    // form ("client.query while the client is executing a query") is deprecated
    // and removed in pg@9. Same in-transaction snapshot either way.
    const destSysRes = await client.query<{ id: string; eveSystemId: number | null; name: string; notes: string; x: number; y: number }>(
      `SELECT id, eve_system_id AS "eveSystemId", name, notes, position_x AS x, position_y AS y
         FROM map_systems WHERE map_id = $1`, [destId]);
    const destConnRes = await client.query<{ sourceId: string; targetId: string }>(
      `SELECT source_id AS "sourceId", target_id AS "targetId" FROM map_connections WHERE map_id = $1`, [destId]);
    const srcSysRes = await client.query<{
      id: string; eveSystemId: number | null; name: string; systemClass: string; effect: string;
      statics: string[]; regionName: string | null; npcType: string | null; x: number; y: number;
      status: string; notes: string;
    }>(
      `SELECT id, eve_system_id AS "eveSystemId", name, system_class AS "systemClass", effect, statics,
              region_name AS "regionName", npc_type AS "npcType", position_x AS x, position_y AS y, status, notes
         FROM map_systems WHERE map_id = $1`, [sourceId]);
    const srcConnRes = await client.query<{
      sourceId: string; targetId: string; sourceHandle: string | null; targetHandle: string | null;
      connectionType: string; massStatus: string | null; timeStatus: string | null; size: string; whType: string | null;
    }>(
      `SELECT source_id AS "sourceId", target_id AS "targetId", source_handle AS "sourceHandle",
              target_handle AS "targetHandle", connection_type AS "connectionType",
              mass_status AS "massStatus", time_status AS "timeStatus", size, wh_type AS "whType"
         FROM map_connections WHERE map_id = $1`, [sourceId]);

    if (srcSysRes.rows.length > MAX_IMPORT_SYSTEMS) {
      await client.query('ROLLBACK');
      res.status(413).json({ error: `Source map too large (max ${MAX_IMPORT_SYSTEMS} systems)` });
      return;
    }

    // ── Destination lookup (truth) — keep each system's position so we can
    // align incoming systems into the destination's coordinate frame ────────
    const destByEve  = new Map<number, { id: string; notes: string; x: number; y: number }>();
    const destByName = new Map<string, { id: string; notes: string; x: number; y: number }>();
    let destMaxX = -Infinity, destMinY = Infinity;
    for (const d of destSysRes.rows) {
      const ref = { id: d.id, notes: d.notes, x: d.x, y: d.y };
      if (d.eveSystemId != null) destByEve.set(d.eveSystemId, ref);
      destByName.set(d.name.toLowerCase(), ref);
      destMaxX = Math.max(destMaxX, d.x);
      destMinY = Math.min(destMinY, d.y);
    }
    const hasDest = destSysRes.rows.length > 0;

    // ── Classify source systems: matched (dedup) vs new (to insert) ─────────
    // Collect matched (source position → destination position) pairs so we can
    // fit a transform and drop new systems where they belong relative to the
    // systems both maps share — rather than as a far-away block.
    const idMap = new Map<string, string>();                 // srcSystemId → destSystemId
    const noteMerges: { destSysId: string; notes: string }[] = [];
    const matchedPairs: { sx: number; sy: number; dx: number; dy: number }[] = [];
    const newSystems: { row: typeof srcSysRes.rows[number]; newId: string }[] = [];

    for (const s of srcSysRes.rows) {
      const matched =
        (s.eveSystemId != null ? destByEve.get(s.eveSystemId) : undefined)
        ?? destByName.get(String(s.name).toLowerCase());

      if (matched) {
        idMap.set(s.id, matched.id);
        matchedPairs.push({ sx: s.x, sy: s.y, dx: matched.x, dy: matched.y });
        if (include.notes) {
          const merged = mergeSystemNote(matched.notes, s.notes, srcMeta.name);
          if (merged !== null) noteMerges.push({ destSysId: matched.id, notes: merged });
        }
        continue;
      }
      newSystems.push({ row: s, newId: crypto.randomUUID() });
      idMap.set(s.id, newSystems[newSystems.length - 1].newId);
    }
    const addedSystems = newSystems.length;

    // ── Place the new systems ───────────────────────────────────────────────
    // Preferred: fit translation + uniform scale from the matched pairs (both
    // maps came from the same region projection, so this aligns the incoming
    // layout to the destination's frame). Fallback (no shared systems): drop
    // the source cluster to the right of the destination's bounding box.
    const placed = newSystems.map(({ row, newId }) => ({ row, newId, x: row.x, y: row.y }));
    if (matchedPairs.length > 0) {
      let msx = 0, msy = 0, mdx = 0, mdy = 0;
      for (const p of matchedPairs) { msx += p.sx; msy += p.sy; mdx += p.dx; mdy += p.dy; }
      const n = matchedPairs.length;
      msx /= n; msy /= n; mdx /= n; mdy /= n;
      let srcVar = 0, destVar = 0;
      for (const p of matchedPairs) {
        srcVar  += (p.sx - msx) ** 2 + (p.sy - msy) ** 2;
        destVar += (p.dx - mdx) ** 2 + (p.dy - mdy) ** 2;
      }
      // Uniform scale from the ratio of spreads; needs ≥2 spread-ful pairs,
      // else translation-only (the region projection already shares a scale).
      const s = (n >= 2 && srcVar > 0) ? Math.sqrt(destVar / srcVar) : 1;
      for (const p of placed) {
        p.x = s * (p.row.x - msx) + mdx;
        p.y = s * (p.row.y - msy) + mdy;
      }
    } else if (hasDest) {
      const GAP = 300;
      let srcMinX = Infinity, srcMinY = Infinity;
      for (const s of srcSysRes.rows) { srcMinX = Math.min(srcMinX, s.x); srcMinY = Math.min(srcMinY, s.y); }
      const offsetX = destMaxX + GAP - srcMinX;
      const offsetY = destMinY - srcMinY;
      for (const p of placed) { p.x = p.row.x + offsetX; p.y = p.row.y + offsetY; }
    }

    // De-overlap the new nodes against the existing (fixed) destination nodes
    // and each other, so aligned positions that land on a neighbour separate
    // out without disturbing the user's existing layout.
    const MIN_DIST = 150;
    const fixed = destSysRes.rows.map((d) => ({ x: d.x, y: d.y }));
    for (let pass = 0; pass < 12; pass++) {
      let moved = false;
      for (const a of placed) {
        for (const f of fixed) {
          let dx = a.x - f.x, dy = a.y - f.y, d = Math.hypot(dx, dy);
          if (d === 0) { dx = 1; dy = 0; d = 1; }
          if (d < MIN_DIST) { a.x += dx / d * (MIN_DIST - d); a.y += dy / d * (MIN_DIST - d); moved = true; }
        }
      }
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i], b = placed[j];
          let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
          if (d === 0) { dx = 1; dy = 0; d = 1; }
          if (d < MIN_DIST) {
            const push = (MIN_DIST - d) / 2, ux = dx / d, uy = dy / d;
            a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }

    // ── Insert the new systems ───────────────────────────────────────────────
    const sysCols = 15;
    const sysPlaceholders: string[] = [];
    const sysValues: unknown[] = [];
    for (const { row, newId, x, y } of placed) {
      const base = sysValues.length;
      sysPlaceholders.push(`(${Array.from({ length: sysCols }, (_, i) => `$${base + i + 1}`).join(',')})`);
      sysValues.push(
        newId, destId, row.eveSystemId, row.name, row.systemClass,
        row.effect ?? 'none', row.statics ?? [], row.regionName ?? null, row.npcType ?? null,
        x, y, row.status ?? 'unknown', false, false,
        include.notes ? (row.notes ?? '') : '',
      );
    }

    if (sysPlaceholders.length > 0) {
      await client.query(
        `INSERT INTO map_systems
           (id, map_id, eve_system_id, name, system_class, effect, statics, region_name, npc_type,
            position_x, position_y, status, is_home, locked, notes)
         VALUES ${sysPlaceholders.join(',')}`,
        sysValues,
      );
    }

    // ── Connections: union, seeded with the destination's existing pairs ─
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const seenPair = new Set<string>();
    for (const c of destConnRes.rows) seenPair.add(pairKey(c.sourceId, c.targetId));

    const connCols = 11;
    const connPlaceholders: string[] = [];
    const connValues: unknown[] = [];
    let addedConnections = 0;
    for (const c of srcConnRes.rows) {
      const src = idMap.get(c.sourceId);
      const tgt = idMap.get(c.targetId);
      if (!src || !tgt || src === tgt) continue;
      const key = pairKey(src, tgt);
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      const base = connValues.length;
      connPlaceholders.push(`(${Array.from({ length: connCols }, (_, i) => `$${base + i + 1}`).join(',')})`);
      connValues.push(
        crypto.randomUUID(), destId, src, tgt, c.sourceHandle ?? null, c.targetHandle ?? null,
        c.connectionType ?? 'standard', c.massStatus ?? null, c.timeStatus ?? null, c.size ?? 'large', c.whType ?? null,
      );
      addedConnections++;
    }
    if (connPlaceholders.length > 0) {
      await client.query(
        `INSERT INTO map_connections
           (id, map_id, source_id, target_id, source_handle, target_handle,
            connection_type, mass_status, time_status, size, wh_type)
         VALUES ${connPlaceholders.join(',')}`,
        connValues,
      );
    }

    const srcSysIds  = srcSysRes.rows.map((s) => s.id);
    const destSysIds = [...new Set(idMap.values())];

    // ── Signatures: upsert by sig_id within the destination system ───────
    let addedSignatures = 0, updatedSignatures = 0;
    if (include.signatures && srcSysIds.length > 0) {
      const srcSigs = await client.query<{ systemId: string; sigId: string; sigType: string; name: string; notes: string; whType: string; whLeadsTo: string }>(
        `SELECT system_id AS "systemId", sig_id AS "sigId", sig_type AS "sigType", name, notes,
                wh_type AS "whType", wh_leads_to AS "whLeadsTo"
           FROM map_signatures WHERE system_id = ANY($1::uuid[])`, [srcSysIds]);
      const destSigs = await client.query<{ id: string; systemId: string; sigId: string }>(
        `SELECT id, system_id AS "systemId", sig_id AS "sigId"
           FROM map_signatures WHERE system_id = ANY($1::uuid[])`, [destSysIds]);
      const destSigMap = new Map<string, string>(); // `${destSysId}|${sigIdLower}` → dest sig id
      for (const ds of destSigs.rows) {
        const k = ds.sigId.trim().toLowerCase();
        if (k) destSigMap.set(`${ds.systemId}|${k}`, ds.id);
      }
      const sigPh: string[] = []; const sigVals: unknown[] = [];
      // Collisions are collected and flushed as one set-based UPDATE (below)
      // instead of a query per row inside the transaction.
      const sigUp: { id: string; sigType: string; name: string; notes: string; whType: string; whLeadsTo: string }[] = [];
      for (const sg of srcSigs.rows) {
        const destSysId = idMap.get(sg.systemId);
        if (!destSysId) continue;
        const k = sg.sigId.trim().toLowerCase();
        const existing = k ? destSigMap.get(`${destSysId}|${k}`) : undefined;
        if (existing) {
          sigUp.push({ id: existing, sigType: sg.sigType, name: sg.name, notes: sg.notes, whType: sg.whType, whLeadsTo: sg.whLeadsTo });
          updatedSignatures++;
        } else {
          const base = sigVals.length;
          sigPh.push(`(${Array.from({ length: 9 }, (_, i) => `$${base + i + 1}`).join(',')})`);
          // from_merge = TRUE → excluded from user stats / admin reporting; the
          // sig was copied in, not scanned. (The update branch above leaves
          // pre-existing dest sigs as-is, so they stay countable.)
          sigVals.push(destSysId, sg.sigId, sg.sigType, sg.name, sg.notes, sg.whType, sg.whLeadsTo, req.session.userId, true);
          addedSignatures++;
        }
      }
      if (sigUp.length > 0) {
        // One UPDATE for every collision — unnest of per-column arrays (6 params
        // total, no param-cap / no per-row round-trips).
        await client.query(
          `UPDATE map_signatures AS m
              SET sig_type = v.sig_type, name = v.name, notes = v.notes,
                  wh_type = v.wh_type, wh_leads_to = v.wh_leads_to, updated_at = NOW()
             FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
                  AS v(id, sig_type, name, notes, wh_type, wh_leads_to)
            WHERE m.id = v.id`,
          [sigUp.map(u => u.id), sigUp.map(u => u.sigType), sigUp.map(u => u.name),
           sigUp.map(u => u.notes), sigUp.map(u => u.whType), sigUp.map(u => u.whLeadsTo)],
        );
      }
      if (sigPh.length > 0) {
        await client.query(
          `INSERT INTO map_signatures (system_id, sig_id, sig_type, name, notes, wh_type, wh_leads_to, created_by_user_id, from_merge)
           VALUES ${sigPh.join(',')}`, sigVals,
        );
      }
    }

    // ── Structures: upsert by eve_id, falling back to name, per system ───
    let addedStructures = 0, updatedStructures = 0;
    if (include.structures && srcSysIds.length > 0) {
      const srcStructs = await client.query<{ systemId: string; name: string; structureType: string; ownerCorp: string; eveId: string | null; notes: string; ownerCorpId: number | null }>(
        `SELECT system_id AS "systemId", name, structure_type AS "structureType", owner_corp AS "ownerCorp",
                eve_id AS "eveId", notes, owner_corp_id AS "ownerCorpId"
           FROM map_structures WHERE system_id = ANY($1::uuid[])`, [srcSysIds]);
      const destStructs = await client.query<{ id: string; systemId: string; name: string; eveId: string | null }>(
        `SELECT id, system_id AS "systemId", name, eve_id AS "eveId"
           FROM map_structures WHERE system_id = ANY($1::uuid[])`, [destSysIds]);
      const byEve  = new Map<string, string>(); // `${destSysId}|${eveId}`     → id
      const byName = new Map<string, string>(); // `${destSysId}|${nameLower}` → id
      for (const d of destStructs.rows) {
        if (d.eveId != null) byEve.set(`${d.systemId}|${d.eveId}`, d.id);
        const nk = (d.name ?? '').trim().toLowerCase();
        if (nk) byName.set(`${d.systemId}|${nk}`, d.id);
      }
      const stPh: string[] = []; const stVals: unknown[] = [];
      const stUp: { id: string; name: string; structureType: string; ownerCorp: string; ownerCorpId: number | null; eveId: string | null; notes: string }[] = [];
      for (const st of srcStructs.rows) {
        const destSysId = idMap.get(st.systemId);
        if (!destSysId) continue;
        let existing = st.eveId != null ? byEve.get(`${destSysId}|${st.eveId}`) : undefined;
        if (!existing) {
          const nk = (st.name ?? '').trim().toLowerCase();
          if (nk) existing = byName.get(`${destSysId}|${nk}`);
        }
        if (existing) {
          stUp.push({ id: existing, name: st.name, structureType: st.structureType, ownerCorp: st.ownerCorp, ownerCorpId: st.ownerCorpId, eveId: st.eveId, notes: st.notes });
          updatedStructures++;
        } else {
          const base = stVals.length;
          stPh.push(`(${Array.from({ length: 8 }, (_, i) => `$${base + i + 1}`).join(',')})`);
          stVals.push(destSysId, st.name, st.structureType, st.ownerCorp, st.eveId, st.notes, req.session.userId, st.ownerCorpId);
          addedStructures++;
        }
      }
      if (stUp.length > 0) {
        await client.query(
          `UPDATE map_structures AS m
              SET name = v.name, structure_type = v.structure_type, owner_corp = v.owner_corp,
                  owner_corp_id = v.owner_corp_id, eve_id = v.eve_id, notes = v.notes, updated_at = NOW()
             FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::int[], $6::bigint[], $7::text[])
                  AS v(id, name, structure_type, owner_corp, owner_corp_id, eve_id, notes)
            WHERE m.id = v.id`,
          [stUp.map(u => u.id), stUp.map(u => u.name), stUp.map(u => u.structureType), stUp.map(u => u.ownerCorp),
           stUp.map(u => u.ownerCorpId), stUp.map(u => u.eveId), stUp.map(u => u.notes)],
        );
      }
      if (stPh.length > 0) {
        await client.query(
          `INSERT INTO map_structures (system_id, name, structure_type, owner_corp, eve_id, notes, created_by_user_id, owner_corp_id)
           VALUES ${stPh.join(',')}`, stVals,
        );
      }
    }

    // ── Apply queued system-note merges (one set-based UPDATE) ────────────
    if (noteMerges.length > 0) {
      await client.query(
        `UPDATE map_systems AS m SET notes = v.notes
           FROM unnest($1::uuid[], $2::text[]) AS v(id, notes)
          WHERE m.id = v.id`,
        [noteMerges.map((nm) => nm.destSysId), noteMerges.map((nm) => nm.notes)],
      );
    }

    // ── Audit: one row per corp map involved (inside the transaction) ────
    if (srcMeta.corp_id !== null) {
      await audit(req, srcMeta.user_id, srcMeta.owner_char, 'corp_map_merge_source', srcMeta.name, destMeta.name, client);
    }
    if (destMeta.corp_id !== null) {
      await audit(req, destMeta.user_id, destMeta.owner_char, 'corp_map_merge_destination', srcMeta.name, destMeta.name, client);
    }

    await client.query(`UPDATE maps SET updated_at = NOW() WHERE id = $1`, [destId]);
    await client.query('COMMIT');

    // A merge touches many rows — tell other viewers of the destination to
    // re-fetch rather than streaming hundreds of deltas. The initiator already
    // reloads in the merge modal, so it's echo-suppressed.
    publishToMap(destId, { type: 'map.resync', actor: req.get('x-client-id') ?? null });

    res.json({
      added:   { systems: addedSystems, connections: addedConnections, signatures: addedSignatures, structures: addedStructures },
      updated: { signatures: updatedSignatures, structures: updatedStructures, systemNotes: noteMerges.length },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    log.error('map merge failed:', err);
    throw err;
  } finally {
    client.release();
  }
});

// GET /api/maps/:mapId  — full map (systems + connections)
mapsRouter.get('/:mapId', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }

  // Full map (meta + systems + connections). Loader is shared with /api/v1.
  const full = await loadFullMap(mapId);
  if (!full) { res.status(404).json({ error: 'Map not found' }); return; }
  // Surface the caller's access so the client can hide edit UI it would 403 on.
  // Authoritative check still happens per-write server-side; this is UX only.
  // shareCanWrite is only meaningful for accessKind 'shared'.
  res.json({ ...full, accessKind: access.accessKind, shareCanWrite: access.shareCanWrite ?? null });
});

// GET /api/maps/:mapId/events — SSE stream of live edits for this map. Scoped
// per map and access-checked, so a client only ever receives events for a map
// it's allowed to see. See realtime_sync_feature.md.
mapsRouter.get('/:mapId/events', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  // Shared with the API-key stream at /api/v1/maps/:id/events.
  streamMapEvents(req, res, mapId);
});

// GET /api/maps/:mapId/kills/backfill — recent high-value kills in the map's
// systems, to seed the kill-log panel on open. Served from the in-memory buffer
// the live feed fills (services/killBuffer) — no zKillboard REST calls, so it's
// instant and scales to any map size. Access-checked. Returns KillRow[]
// newest-first. (The buffer only holds kills since the server booted, so right
// after a restart the log fills in as the feed runs.)
mapsRouter.get('/:mapId/kills/backfill', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }

  const { rows } = await db.query<{ eveSystemId: number }>(
    `SELECT DISTINCT eve_system_id AS "eveSystemId"
       FROM map_systems WHERE map_id = $1 AND eve_system_id IS NOT NULL`,
    [mapId],
  );
  const systemIds = new Set(rows.map((r) => r.eveSystemId));
  if (!systemIds.size) { res.json([]); return; }

  const buffered = recentKillsForSystems(systemIds, 200);
  const kills = await Promise.all(buffered.map(buildKillRow));
  res.json(kills);
});

// POST /api/maps/:mapId/presence — a viewer reports its current location.
// Identity comes from the session (never trusted from the body). Viewing access
// is enough (even readonly corp members show presence). See presence_feature.md.
mapsRouter.post('/:mapId/presence', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  const characterId   = req.session.characterId;
  const characterName = req.session.characterName;
  if (!characterId || !characterName) { res.status(401).json({ error: 'No character on session' }); return; }

  const body = req.body as { eveSystemId?: unknown; shipTypeId?: unknown; presentSystemIds?: unknown };
  reportPresence(mapId, {
    characterId,
    characterName,
    eveSystemId: typeof body.eveSystemId === 'number' ? body.eveSystemId : null,
    shipTypeId:  typeof body.shipTypeId  === 'number' ? body.shipTypeId  : null,
  }, req.get('x-client-id') ?? null);

  // A character physically in a mapped system keeps it "active" so it never
  // shows as stale while occupied — independent of whether any sigs/anoms are
  // touched, and independent of which character is the active viewer. The client
  // sends presentSystemIds = every system one of the account's *online*
  // characters is in right now (active viewer + any online alt), so a tracked
  // alt — or an alt flying a different route — revives its own system too. Older
  // clients send only eveSystemId; fold it in for back-compat.
  // Throttled at the column: the UPDATE only matches (and only then broadcasts)
  // systems whose activity is already older than a few minutes, so the 25 s
  // heartbeat doesn't write/broadcast every tick. Fire-and-forget — never block
  // the presence ack.
  const presentIds = new Set<number>();
  if (Array.isArray(body.presentSystemIds)) {
    for (const id of body.presentSystemIds) if (typeof id === 'number') presentIds.add(id);
  }
  if (typeof body.eveSystemId === 'number') presentIds.add(body.eveSystemId);
  if (presentIds.size) {
    db.query(
      `UPDATE map_systems SET last_activity_at = NOW()
         WHERE map_id = $1 AND eve_system_id = ANY($2::int[])
           AND last_activity_at < NOW() - INTERVAL '5 minutes'
       RETURNING id, last_activity_at`,
      [mapId, [...presentIds]],
    ).then((r) => {
      for (const row of r.rows as Array<{ id: string; last_activity_at: Date }>) {
        publishToMap(mapId, {
          type: 'system.update',
          actor: null,
          id: row.id,
          updates: { lastActivityAt: new Date(row.last_activity_at).toISOString() },
        });
      }
    }).catch(() => { /* best-effort: a failed activity bump must not break presence */ });
  }

  res.status(204).end();
});

// PATCH /api/maps/:mapId  — rename (corp/owner only), lock (admin only), or
// toggle merge-source eligibility (corp maps, full/admin only)
mapsRouter.patch('/:mapId', async (req, res) => {
  const { mapId } = req.params;
  const { name, locked, allowAsMergeSource, allowAsMergeDestination, lazyRemoveWormholes, collapseGraceHours, bookmarkFormat, siteBookmarkFormat, skipKspace } = req.body as {
    name?: string; locked?: boolean; allowAsMergeSource?: boolean; allowAsMergeDestination?: boolean;
    lazyRemoveWormholes?: boolean; collapseGraceHours?: number; bookmarkFormat?: string | null; siteBookmarkFormat?: string | null; skipKspace?: boolean;
  };

  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  // Captured (validated) collapse-grace value, for the live-sync broadcast below.
  let normalizedGrace: number | undefined;

  // Merge opt-in flags are corp-map sharing policy: only meaningful on a corp
  // map, and gated above ordinary edit access to full/admin.
  if (allowAsMergeSource !== undefined || allowAsMergeDestination !== undefined) {
    if (access.corpId === null) {
      res.status(400).json({ error: 'Only corp maps can be flagged as a merge source/destination' }); return;
    }
    const role = req.session.role ?? 'readonly';
    if (role !== 'full' && !isAdmin(role)) {
      res.status(403).json({ error: 'Full-edit or admin role required' }); return;
    }
    if (allowAsMergeSource !== undefined) {
      sets.push(`allow_as_merge_source = $${vals.length + 1}`); vals.push(allowAsMergeSource === true);
    }
    if (allowAsMergeDestination !== undefined) {
      sets.push(`allow_as_merge_destination = $${vals.length + 1}`); vals.push(allowAsMergeDestination === true);
    }
  }

  if (name !== undefined) {
    // Shared recipients have edit access but not rename — the title is
    // an identity-level property only the map's true owner / corp should
    // change. Without this guard a shared user could quietly rename
    // someone else's map from their map list.
    if (access.accessKind === 'shared') {
      res.status(403).json({ error: 'Only the owner can rename this map' }); return;
    }
    // Renaming an alliance map is a management action reserved for alliance
    // admins — checked on the map's alliance scope, not accessKind, so a former
    // alliance admin who created it (and now resolves as 'owner') can't rename
    // it after being demoted. Matches the delete gate.
    if (access.allianceId !== null && !isAllianceAdmin(req.session.role ?? 'readonly')) {
      res.status(403).json({ error: 'Only an alliance admin can rename this map' }); return;
    }
    const trimmed = String(name).slice(0, MAX_MAP_NAME_LEN);
    if (!trimmed) { res.status(400).json({ error: 'name cannot be empty' }); return; }
    sets.push(`name = $${vals.length + 1}`); vals.push(trimmed);
  }
  if (locked !== undefined) {
    // Alliance maps lock with the alliance admin role; corp/personal maps with
    // an ordinary admin. Alliance-map management never falls to a corp admin.
    const role = req.session.role ?? 'readonly';
    const allianceScoped = access.allianceId !== null;
    if (allianceScoped ? !isAllianceAdmin(role) : !isAdmin(role)) {
      res.status(403).json({ error: allianceScoped ? 'Alliance admin access required' : 'Admin access required' }); return;
    }
    sets.push(`locked = $${vals.length + 1}`); vals.push(locked);
  }
  // Map-level "Don't track K-space" policy — corp/alliance maps only, and gated
  // to owner/admins exactly like the lock: alliance maps need the alliance admin
  // role, corp maps an ordinary admin. Overrides each member's personal
  // nexum.tracking.skipKspace while they are on this map.
  if (skipKspace !== undefined) {
    if (access.corpId === null && access.allianceId === null) {
      res.status(400).json({ error: 'Only corp/alliance maps have a K-space tracking policy' }); return;
    }
    const role = req.session.role ?? 'readonly';
    const allianceScoped = access.allianceId !== null;
    if (allianceScoped ? !isAllianceAdmin(role) : !isAdmin(role)) {
      res.status(403).json({ error: allianceScoped ? 'Alliance admin access required' : 'Admin access required' }); return;
    }
    sets.push(`skip_kspace = $${vals.length + 1}`); vals.push(skipKspace === true);
  }
  // Lazy WH-removal opt-in: a plain per-map behaviour toggle any editor can set
  // (no corp/admin gate). The sweep itself runs server-side on this cadence.
  if (lazyRemoveWormholes !== undefined) {
    sets.push(`lazy_remove_wormholes = $${vals.length + 1}`); vals.push(lazyRemoveWormholes === true);
  }
  // Per-map collapse grace (hours) — how long an expired hole waits before the
  // sweep severs it and drops its sigs. Another plain per-map behaviour setting;
  // clamp to a sane 0–24h so a bad value can't wedge the sweep.
  if (collapseGraceHours !== undefined) {
    const n = Number(collapseGraceHours);
    if (!Number.isFinite(n) || n < 0 || n > 24) {
      res.status(400).json({ error: 'collapseGraceHours must be a number between 0 and 24' }); return;
    }
    sets.push(`collapse_grace_hours = $${vals.length + 1}`); vals.push(n);
    normalizedGrace = n;
  }

  // Per-map bookmark-name format: a shared policy that overrides every member's
  // personal format, so it's owner/admin-gated exactly like the K-space policy /
  // rename — shared recipients never; corp maps need an admin; alliance maps an
  // alliance admin; a personal map's owner is fine. An empty/whitespace/null
  // value clears the override so users fall back to their own global format.
  // Stored trimmed and length-capped.
  let normalizedBookmarkFmt: string | null | undefined;
  let normalizedSiteBookmarkFmt: string | null | undefined;
  // Wormhole and site bookmark formats share the same owner/admin gate; check
  // it once, then apply whichever field(s) were sent.
  if (bookmarkFormat !== undefined || siteBookmarkFormat !== undefined) {
    const role = req.session.role ?? 'readonly';
    if (access.accessKind === 'shared') {
      res.status(403).json({ error: 'Only the map owner can change the shared bookmark format' }); return;
    }
    if (access.corpId !== null || access.allianceId !== null) {
      const allianceScoped = access.allianceId !== null;
      // 'full' control (and up) may manage the shared bookmark formats, alongside
      // the corp/alliance admin tiers.
      const allowed = role === 'full' || (allianceScoped ? isAllianceAdmin(role) : isAdmin(role));
      if (!allowed) {
        res.status(403).json({ error: allianceScoped ? 'Full or alliance-admin access required' : 'Full or admin access required' }); return;
      }
    }
    if (bookmarkFormat !== undefined) {
      const trimmed = typeof bookmarkFormat === 'string' ? bookmarkFormat.trim().slice(0, MAX_BOOKMARK_FMT_LEN) : '';
      normalizedBookmarkFmt = trimmed === '' ? null : trimmed;
      sets.push(`bookmark_format = $${vals.length + 1}`); vals.push(normalizedBookmarkFmt);
    }
    if (siteBookmarkFormat !== undefined) {
      const trimmed = typeof siteBookmarkFormat === 'string' ? siteBookmarkFormat.trim().slice(0, MAX_BOOKMARK_FMT_LEN) : '';
      normalizedSiteBookmarkFmt = trimmed === '' ? null : trimmed;
      sets.push(`site_bookmark_format = $${vals.length + 1}`); vals.push(normalizedSiteBookmarkFmt);
    }
  }

  if (sets.length === 1) { res.status(400).json({ error: 'Nothing to update' }); return; }

  await db.query(`UPDATE maps SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`, [...vals, mapId]);
  // Live-sync every map-level setting to the other viewers (and the same user's
  // other tabs). All of these are per-map state that must stay consistent
  // without a reload; the originating client suppresses its own echo by actor.
  if (sets.length > 1) {
    publishToMap(mapId, {
      type: 'map.meta',
      actor: req.get('x-client-id') ?? null,
      ...(name !== undefined ? { name: String(name).slice(0, MAX_MAP_NAME_LEN) } : {}),
      ...(locked !== undefined ? { locked } : {}),
      ...(allowAsMergeSource !== undefined ? { allowAsMergeSource: allowAsMergeSource === true } : {}),
      ...(allowAsMergeDestination !== undefined ? { allowAsMergeDestination: allowAsMergeDestination === true } : {}),
      ...(skipKspace !== undefined ? { skipKspace: skipKspace === true } : {}),
      ...(lazyRemoveWormholes !== undefined ? { lazyRemoveWormholes: lazyRemoveWormholes === true } : {}),
      ...(normalizedGrace !== undefined ? { collapseGraceHours: normalizedGrace } : {}),
      ...(normalizedBookmarkFmt !== undefined ? { bookmarkFormat: normalizedBookmarkFmt } : {}),
      ...(normalizedSiteBookmarkFmt !== undefined ? { siteBookmarkFormat: normalizedSiteBookmarkFmt } : {}),
    });
  }
  res.json({ ok: true });
});

// DELETE /api/maps/:mapId — owner can delete personal maps; admin can delete any
mapsRouter.delete('/:mapId', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }

  const isOwner       = access.userId === req.session.userId;
  const isCorpMap     = access.corpId !== null;
  const isAllianceMap = access.allianceId !== null;
  const role          = req.session.role ?? 'readonly';

  if (isAllianceMap && !isAllianceAdmin(role)) {
    res.status(403).json({ error: 'Only an alliance admin can delete alliance maps' }); return;
  }
  if (isCorpMap && !isAdmin(role)) {
    res.status(403).json({ error: 'Only admins can delete corp maps' }); return;
  }
  if (!isOwner && !isAdmin(role)) {
    res.status(403).json({ error: 'Not authorised' }); return;
  }

  await db.query(`DELETE FROM maps WHERE id = $1`, [mapId]);
  res.json({ ok: true });
});

// ── Systems ───────────────────────────────────────────────────────────────────

mapsRouter.post('/:mapId/systems', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  const { id, eveSystemId, name, systemClass, effect, statics, regionName, npcType, position, status, isHome, locked, notes } = req.body;

  const resolvedEveId = await resolveEveSystemId(eveSystemId, name);

  try {
    await db.query(
      `INSERT INTO map_systems
         (id, map_id, eve_system_id, name, system_class, effect, statics, region_name, npc_type,
          position_x, position_y, status, is_home, locked, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO NOTHING`,
      [id, mapId, resolvedEveId, name, systemClass, effect ?? 'none',
       statics ?? [], regionName ?? null, npcType ?? null,
       position?.x ?? 0, position?.y ?? 0,
       status ?? 'unknown', isHome ?? false, locked ?? false, notes ?? ''],
    );
  } catch (err) {
    // Unique-constraint violation on (map_id, eve_system_id) — caller is
    // trying to add a system that's already on the map. Return the
    // canonical id so the client can swap its local placeholder for the
    // real node instead of producing a duplicate.
    if ((err as { code?: string }).code === '23505' && resolvedEveId != null) {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM map_systems WHERE map_id = $1 AND eve_system_id = $2`,
        [mapId, resolvedEveId],
      );
      res.status(409).json({ error: 'System already on map', existingId: rows[0]?.id });
      return;
    }
    throw err;
  }
  db.query(
    `INSERT INTO user_events (user_id, event_type, map_id) VALUES ($1, 'system_add', $2)`,
    [req.session.userId, mapId],
  ).catch(console.error);
  await touchMap(mapId);

  // Re-read the canonical row so BOTH the live-sync payload and the response
  // match a fresh map load exactly (resolved eve id, SDE security, etc.).
  // Returning it lets the originating client backfill server-derived fields
  // (e.g. security) onto its optimistic node — it's echo-suppressed from the
  // broadcast below, so without this its node would lack sec status until a
  // full reload.
  let system: ({ position: { x: number; y: number } } & Record<string, unknown>) | null = null;
  try {
    const { rows } = await db.query(
      `SELECT id, eve_system_id AS "eveSystemId", name, system_class AS "systemClass", effect, statics,
              region_name AS "regionName", npc_type AS "npcType", position_x AS x, position_y AS y,
              status, intel, is_home AS "isHome", locked, notes,
              labels, custom_labels AS "customLabels", tag, alias,
              (SELECT ss.security::float8 FROM solar_systems ss WHERE ss.id = map_systems.eve_system_id) AS "security",
              last_activity_at AS "lastActivityAt"
         FROM map_systems WHERE id = $1 AND map_id = $2`,
      [id, mapId],
    );
    const r = rows[0] as ({ x: number; y: number } & Record<string, unknown>) | undefined;
    if (r) {
      const { x, y, ...rest } = r;
      system = { ...rest, position: { x, y } };
      // Push to other viewers of this map (live sync). actor = originating
      // client → echo-suppressed.
      publishToMap(mapId, { type: 'system.add', actor: req.get('x-client-id') ?? null, system });
    }
  } catch (err) {
    console.error(err);
  }

  res.status(201).json({ ok: true, system });
});

mapsRouter.patch('/:mapId/systems/:systemId', async (req, res) => {
  const { mapId, systemId } = req.params;
  const updates = req.body as Record<string, unknown>;

  // map camelCase → snake_case for the DB columns we accept
  const colMap: Record<string, string> = {
    name: 'name', systemClass: 'system_class', effect: 'effect', statics: 'statics',
    regionName: 'region_name', npcType: 'npc_type',
    status: 'status', isHome: 'is_home', locked: 'locked', notes: 'notes',
  };

  const sets: string[] = [];
  const vals: unknown[] = [];

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) {
      sets.push(`${col} = $${vals.length + 1}`);
      vals.push(updates[key]);
    }
  }

  // Intel tag. Accepts:
  //   - null              → clears the tag
  //   - 'friendly' | 'hostile' | 'occupied' | 'empty'  → built-ins
  //   - any [A-Za-z0-9-]{1,64} string                  → user-defined custom
  //     intel id (UUID generated client-side; label + colour live in
  //     ui_settings.nexum.customIntel for the user that set the tag).
  // The charset cap stops a stale client from stuffing arbitrary text into
  // a `data-intel` attribute that selector rules might choke on.
  if ('intel' in updates) {
    const v = updates.intel;
    const VALID_INTEL_RE = /^[A-Za-z0-9-]{1,64}$/;
    if (v !== null && !(typeof v === 'string' && VALID_INTEL_RE.test(v))) {
      res.status(400).json({ error: 'invalid intel value' }); return;
    }
    sets.push(`intel = $${vals.length + 1}`);
    vals.push(v);
  }

  // Single-character quick tag (one A-Z / 0-9 char), or null to clear. The
  // strict charset stops a stale client stuffing arbitrary text into the badge.
  if ('tag' in updates) {
    const v = updates.tag;
    if (v !== null && !(typeof v === 'string' && /^[A-Za-z0-9]$/.test(v))) {
      res.status(400).json({ error: 'invalid tag' }); return;
    }
    sets.push(`tag = $${vals.length + 1}`);
    vals.push(v);
  }

  // Display-only alias — a label shown in place of the real system name. A string
  // (trimmed, ≤32 chars) or null to clear; empty/whitespace also clears. Purely
  // cosmetic — the real `name` still drives all matching/topology.
  if ('alias' in updates) {
    const v = updates.alias;
    if (v !== null && typeof v !== 'string') { res.status(400).json({ error: 'invalid alias' }); return; }
    const clean = typeof v === 'string' ? v.trim().slice(0, 32) : '';
    sets.push(`alias = $${vals.length + 1}`);
    vals.push(clean || null);
  }

  // Predefined labels — applied as coloured pills above the node. A subset of
  // the fixed id set; deduped before storing.
  if ('labels' in updates) {
    const v = updates.labels;
    const ALLOWED = new Set(['a', 'b', 'c', '1', '2', '3']);
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !ALLOWED.has(x))) {
      res.status(400).json({ error: 'invalid labels' }); return;
    }
    sets.push(`labels = $${vals.length + 1}`);
    vals.push([...new Set(v as string[])]);
  }

  // Custom labels — up to 3 entries, each '<kind>:<color>:<value>' where kind
  // is t|i, color is '#RRGGBB' or empty, value is text (<=40 chars) or a
  // Phosphor icon name. Legacy '<kind>:<value>' (no colour) still accepted.
  if ('customLabels' in updates) {
    const v = updates.customLabels;
    const COLOR = '(#[0-9a-fA-F]{6})?';
    const valid = (s: unknown) =>
      typeof s === 'string' && (
        new RegExp(`^t:${COLOR}:.{1,40}$`).test(s) ||
        new RegExp(`^i:${COLOR}:[A-Za-z0-9]{1,40}$`).test(s) ||
        /^t:.{1,40}$/.test(s) ||              // legacy text
        /^i:[A-Za-z0-9]{1,40}$/.test(s)       // legacy icon
      );
    if (!Array.isArray(v) || v.length > 3 || v.some((x) => !valid(x))) {
      res.status(400).json({ error: 'invalid customLabels' }); return;
    }
    sets.push(`custom_labels = $${vals.length + 1}`);
    vals.push(v);
  }

  // handle position separately
  if (updates.position && typeof updates.position === 'object') {
    const pos = updates.position as { x?: number; y?: number };
    if (pos.x !== undefined) { sets.push(`position_x = $${vals.length + 1}`); vals.push(pos.x); }
    if (pos.y !== undefined) { sets.push(`position_y = $${vals.length + 1}`); vals.push(pos.y); }
  }

  if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }

  // Notes-only updates are content, not topology — they pass through even
  // when an admin has locked the map. Anything else (move, rename, status…)
  // requires the strict lock-aware check.
  const isNotesOnly = Object.keys(updates).length === 1 && 'notes' in updates;
  const access = isNotesOnly
    ? await requireMapContentWrite(res, mapId, req)
    : await requireMapWrite(res, mapId, req);
  if (!access) return;

  // Append last_activity_at = NOW() to mark this system as active.
  await db.query(
    `UPDATE map_systems SET ${sets.join(', ')}, last_activity_at = NOW() WHERE id = $${vals.length + 1} AND map_id = $${vals.length + 2}`,
    [...vals, systemId, mapId],
  );
  await touchMap(mapId);
  publishToMap(mapId, { type: 'system.update', actor: req.get('x-client-id') ?? null, id: systemId, updates });
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/systems/:systemId', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;
  const { rowCount } = await db.query(`DELETE FROM map_systems WHERE id = $1 AND map_id = $2`, [systemId, mapId]);
  if ((rowCount ?? 0) > 0) {
    db.query(
      `INSERT INTO user_events (user_id, event_type, map_id) VALUES ($1, 'system_delete', $2)`,
      [req.session.userId, mapId],
    ).catch(console.error);
    publishToMap(mapId, { type: 'system.remove', actor: req.get('x-client-id') ?? null, id: systemId });
  }
  await touchMap(mapId);
  res.json({ ok: true });
});

// ── Connections ───────────────────────────────────────────────────────────────

mapsRouter.post('/:mapId/connections', async (req, res) => {
  const { mapId } = req.params;
  const { id, sourceId, targetId, sourceHandle, targetHandle, connectionType, massStatus, timeStatus, size, sourceEveId, targetEveId } = req.body;

  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  // Auto-classify in-game gates: a connection between two stargate-adjacent SDE
  // systems is a gate, not a wormhole. Only when the client sent the default
  // 'standard' (a fresh connection carries no wh type yet, so nothing to
  // protect) — an explicit 'gate'/'jumpgate' from the client is respected.
  // Failures (e.g. map_stargates not seeded) leave it as-is.
  let effectiveType: string = connectionType ?? 'standard';
  if (effectiveType === 'standard') {
    try {
      let adjacent = false;
      if (typeof sourceEveId === 'number' && typeof targetEveId === 'number') {
        // Classify straight from the eve ids the client supplied — robust to the
        // freshly-jumped-to system's row not being committed yet (a jump POSTs
        // the new system and this connection near-simultaneously, and the old
        // map_systems join could race the insert and mis-tag the gate as a hole).
        const adj = await db.query(
          `SELECT 1 FROM map_stargates g
            WHERE (g.system_id = $1 AND g.destination_system_id = $2)
               OR (g.system_id = $2 AND g.destination_system_id = $1)
            LIMIT 1`,
          [sourceEveId, targetEveId],
        );
        adjacent = (adj.rowCount ?? 0) > 0;
      } else {
        const adj = await db.query(
          `SELECT 1 FROM map_systems s, map_systems t
            WHERE s.id = $1 AND t.id = $2
              AND s.eve_system_id IS NOT NULL AND t.eve_system_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM map_stargates g
                 WHERE (g.system_id = s.eve_system_id AND g.destination_system_id = t.eve_system_id)
                    OR (g.system_id = t.eve_system_id AND g.destination_system_id = s.eve_system_id)
              )
            LIMIT 1`,
          [sourceId, targetId],
        );
        adjacent = (adj.rowCount ?? 0) > 0;
      }
      if (adjacent) effectiveType = 'gate';
    } catch { /* stargate table absent / query failed — keep client's type */ }
  }

  let inserted = 0;
  try {
    const ins = await db.query(
      `INSERT INTO map_connections
         (id, map_id, source_id, target_id, source_handle, target_handle,
          connection_type, mass_status, time_status, size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [id, mapId, sourceId, targetId, sourceHandle ?? null, targetHandle ?? null,
       effectiveType, massStatus ?? null, timeStatus ?? null, size ?? 'large'],
    );
    inserted = ins.rowCount ?? 0;
  } catch (err) {
    // FK violation = one of the endpoint systems doesn't exist on the
    // server (likely a client race: connection POST arrived before its
    // system POST). Returning 409 lets the client retry rather than
    // crashing the whole node and freezing every other user on the map.
    if ((err as { code?: string }).code === '23503') {
      log.warn(`Connection FK violation on map ${mapId}: ${(err as { detail?: string }).detail ?? 'unknown'}`);
      res.status(409).json({ error: 'Endpoint system missing — refresh and retry' });
      return;
    }
    throw err;
  }
  await touchMap(mapId);
  // Re-read the canonical row so remote clients get the full MapConnection shape.
  db.query(
    `SELECT ${CONNECTION_COLS} FROM map_connections WHERE id = $1 AND map_id = $2`,
    [id, mapId],
  ).then(({ rows }) => {
    if (rows[0]) publishToMap(mapId, { type: 'connection.add', actor: req.get('x-client-id') ?? null, connection: rows[0] });
  }).catch(console.error);
  // Broadcast a genuinely new wormhole connection — not a duplicate-id retry,
  // and not an in-game gate/Ansiblex. If no sig backs it yet (manual connect
  // before scanning), this is a no-op that leaves discord_notified false, so
  // the later type PATCH from sig auto-detect fires it instead.
  if (inserted > 0 && effectiveType === 'standard') {
    maybeBroadcastConnection(access, mapId, id, req.session.characterName ?? null);
  }
  // Return the resolved type so the originating client can reflect an
  // auto-classified gate without waiting for a reload.
  res.status(201).json({ ok: true, connectionType: effectiveType });
});

// POST /api/maps/:mapId/reclassify-gates — one-shot repair. Retype 'standard'
// (wormhole) connections whose two endpoints are actually stargate-adjacent
// (per the SDE map_stargates) to 'gate'. Fixes maps built while map_stargates
// was unseeded, or connections created before gate auto-classification, where
// gate hops piled up as wormhole lines. Never touches a connection carrying a
// wormhole type (a real scanned hole) or one already typed gate/jumpgate.
mapsRouter.post('/:mapId/reclassify-gates', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;
  try {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE map_connections c
          SET connection_type = 'gate'
        WHERE c.map_id = $1
          AND c.connection_type = 'standard'
          AND (c.wh_type IS NULL OR c.wh_type = '')
          AND EXISTS (
            SELECT 1 FROM map_systems s, map_systems t
             WHERE s.id = c.source_id AND t.id = c.target_id
               AND s.eve_system_id IS NOT NULL AND t.eve_system_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM map_stargates g
                  WHERE (g.system_id = s.eve_system_id AND g.destination_system_id = t.eve_system_id)
                     OR (g.system_id = t.eve_system_id AND g.destination_system_id = s.eve_system_id)
               )
          )
        RETURNING c.id`,
      [mapId],
    );
    if (rows.length > 0) {
      await touchMap(mapId);
      // Server-originated → actor null so every viewer applies the retype live.
      for (const r of rows) {
        publishToMap(mapId, { type: 'connection.update', actor: null, id: r.id, updates: { connectionType: 'gate' } });
      }
    }
    res.json({ ok: true, reclassified: rows.length });
  } catch (err) {
    log.error(`reclassify-gates failed for map ${mapId}:`, err);
    res.status(500).json({ error: 'Reclassify failed' });
  }
});

// Re-pick every connection's attach handles for a fresh set of system positions
// — the server-side equivalent of the client "optimise connections" — so a
// layout repair also tidies which side of each node its lines meet. Mirrors the
// client's pickHandles() (pure dx/dy geometry). Bulk-updates only the changed
// handles and broadcasts them; a connection whose endpoints aren't both in `pos`
// is skipped.
async function optimizeConnectionHandles(
  mapId: string,
  pos: Map<string, { x: number; y: number }>,
  conns: { id: string; sourceId: string; targetId: string; sourceHandle: string | null; targetHandle: string | null }[],
): Promise<void> {
  const changed: { id: string; sh: string; th: string }[] = [];
  for (const c of conns) {
    const s = pos.get(c.sourceId), t = pos.get(c.targetId);
    if (!s || !t) continue;
    const dx = t.x - s.x, dy = t.y - s.y;
    const [sh, th] = Math.abs(dx) >= Math.abs(dy)
      ? (dx >= 0 ? ['right', 'left'] : ['left', 'right'])
      : (dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom']);
    if (c.sourceHandle !== sh || c.targetHandle !== th) changed.push({ id: c.id, sh, th });
  }
  if (!changed.length) return;
  const values: string[] = [];
  const params: unknown[] = [mapId];
  let i = 2;
  for (const c of changed) {
    values.push(`($${i}::text, $${i + 1}::text, $${i + 2}::text)`);
    params.push(c.id, c.sh, c.th);
    i += 3;
  }
  await db.query(
    `UPDATE map_connections AS m
        SET source_handle = v.sh, target_handle = v.th
       FROM (VALUES ${values.join(',')}) AS v(id, sh, th)
      WHERE m.id::text = v.id AND m.map_id = $1`,
    params,
  );
  for (const c of changed) {
    publishToMap(mapId, { type: 'connection.update', actor: null, id: c.id, updates: { sourceHandle: c.sh, targetHandle: c.th } });
  }
}

// POST /api/maps/:mapId/geographic-layout — one-shot "tidy layout". Geography in
// EVE is only meaningful *within* a region (systems in one region sit close;
// regions are galactically far apart), so a single global scale would collapse
// each region into an unreadable pile. Instead we (1) group resolved K-space
// systems by their SDE region and lay each region out in its true local shape
// (scaled to a readable pitch, de-overlapped); (2) pack the region blobs
// compactly onto the canvas; (3) drop wormhole / unresolved systems next to
// whatever they connect to. Locked systems stay put and act as fixed anchors.
// Nothing ever overlaps.
mapsRouter.post('/:mapId/geographic-layout', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;
  try {
    const [sysQ, connQ] = await Promise.all([
      db.query<{ id: string; eveId: number | null; regionId: number | null; px: number | null; py: number | null; locked: boolean; curX: number | null; curY: number | null }>(
        `SELECT ms.id, ms.eve_system_id AS "eveId", ms.locked,
                ms.position_x AS "curX", ms.position_y AS "curY",
                s.pos2d_x AS px, s.pos2d_y AS py, s.region_id AS "regionId"
           FROM map_systems ms
           LEFT JOIN solar_systems s ON s.id = ms.eve_system_id
          WHERE ms.map_id = $1`,
        [mapId],
      ),
      db.query<{ id: string; sourceId: string; targetId: string; sourceHandle: string | null; targetHandle: string | null }>(
        `SELECT id, source_id AS "sourceId", target_id AS "targetId",
                source_handle AS "sourceHandle", target_handle AS "targetHandle"
           FROM map_connections WHERE map_id = $1`,
        [mapId],
      ),
    ]);
    const sysRows = sysQ.rows;
    if (sysRows.length < 2) { res.json({ ok: true, repositioned: 0 }); return; }

    const PITCH  = 340;             // target gap between neighbouring systems
    const BOX_W  = 270, BOX_H = 175; // nominal node footprint for de-overlap
    const GAP    = 190;             // padding between packed region blobs
    const MARGIN = 120;
    type Pt = { id: string; x: number; y: number };

    // Push apart any pair whose nominal boxes intersect, along the shallower
    // axis. `fixed` ids never move (locked systems). O(n^2) per pass; n small.
    const deOverlap = (nodes: Pt[], fixed?: Set<string>) => {
      for (let iter = 0; iter < 400; iter++) {
        let moved = false;
        for (let a = 0; a < nodes.length; a++) {
          for (let b = a + 1; b < nodes.length; b++) {
            const dx = nodes[b].x - nodes[a].x;
            const dy = nodes[b].y - nodes[a].y;
            const ox = BOX_W - Math.abs(dx);
            const oy = BOX_H - Math.abs(dy);
            if (ox <= 0 || oy <= 0) continue;
            const fa = fixed?.has(nodes[a].id) ?? false;
            const fb = fixed?.has(nodes[b].id) ?? false;
            if (fa && fb) continue;
            const sa = fa ? 0 : (fb ? 1 : 0.5);
            const sb = fb ? 0 : (fa ? 1 : 0.5);
            if (ox < oy) {
              const push = ox * (dx < 0 ? -1 : 1);
              nodes[a].x -= push * sa; nodes[b].x += push * sb;
            } else {
              const push = oy * (dy < 0 ? -1 : 1);
              nodes[a].y -= push * sa; nodes[b].y += push * sb;
            }
            moved = true;
          }
        }
        if (!moved) break;
      }
    };

    // Partition: anchored (resolved K-space with a real SDE position -> region
    // layout), locked (user-pinned, never moved), floating (wormhole / unresolved
    // -> placed by their connections).
    const anchored = sysRows.filter((r) => !r.locked && r.eveId != null && r.eveId < 31000000 && r.px != null && r.py != null && r.regionId != null);
    const anchoredIds = new Set(anchored.map((r) => r.id));
    const lockedPos = new Map<string, Pt>();
    for (const r of sysRows) if (r.locked && r.curX != null && r.curY != null) lockedPos.set(r.id, { id: r.id, x: r.curX, y: r.curY });

    // Level 1 — lay out each region in its true local shape.
    const byRegion = new Map<number, typeof anchored>();
    for (const r of anchored) {
      const g = byRegion.get(r.regionId!);
      if (g) g.push(r); else byRegion.set(r.regionId!, [r]);
    }
    type Blob = { pos: Map<string, Pt>; w: number; h: number };
    const blobs: Blob[] = [];
    for (const members of byRegion.values()) {
      if (members.length === 1) {
        blobs.push({ pos: new Map([[members[0].id, { id: members[0].id, x: 0, y: 0 }]]), w: BOX_W, h: BOX_H });
        continue;
      }
      const minX = Math.min(...members.map((m) => m.px!));
      const maxY = Math.max(...members.map((m) => m.py!));
      const nn: number[] = [];
      for (let a = 0; a < members.length; a++) {
        let best = Infinity;
        for (let b = 0; b < members.length; b++) {
          if (a === b) continue;
          const d = Math.hypot(members[a].px! - members[b].px!, members[a].py! - members[b].py!);
          if (d > 0 && d < best) best = d;
        }
        if (best < Infinity) nn.push(best);
      }
      nn.sort((a, b) => a - b);
      const med = nn.length ? nn[Math.floor(nn.length / 2)] : 0;
      const scale = med > 0 ? PITCH / med : PITCH;
      const nodes: Pt[] = members.map((m, k) => ({
        id: m.id,
        x: (m.px! - minX) * scale + (k % 5) - 2,
        y: (maxY - m.py!) * scale + (Math.floor(k / 5) % 5) - 2, // flip Y: SDE grows up, screen grows down
      }));
      deOverlap(nodes);
      const nx = Math.min(...nodes.map((n) => n.x)), ny = Math.min(...nodes.map((n) => n.y));
      const pos = new Map<string, Pt>();
      for (const n of nodes) pos.set(n.id, { id: n.id, x: n.x - nx, y: n.y - ny });
      const w = Math.max(...nodes.map((n) => n.x)) - nx + BOX_W;
      const h = Math.max(...nodes.map((n) => n.y)) - ny + BOX_H;
      blobs.push({ pos, w, h });
    }

    // Level 2 — shelf-pack the region blobs into a compact ~square.
    blobs.sort((a, b) => b.h - a.h);
    const targetW = Math.max(BOX_W, Math.sqrt(blobs.reduce((s, b) => s + b.w * b.h, 0)) * 1.4);
    const placed = new Map<string, Pt>();
    let cx = 0, cy = 0, rowH = 0;
    for (const bl of blobs) {
      if (cx > 0 && cx + bl.w > targetW) { cx = 0; cy += rowH + GAP; rowH = 0; }
      for (const p of bl.pos.values()) placed.set(p.id, { id: p.id, x: p.x + cx + MARGIN, y: p.y + cy + MARGIN });
      cx += bl.w + GAP; rowH = Math.max(rowH, bl.h);
    }
    for (const p of lockedPos.values()) placed.set(p.id, p); // fixed reference points

    // Floating — place wormhole / unresolved systems by their connections,
    // repeating so multi-hop chains settle next to their entry point.
    const neighbors = new Map<string, string[]>();
    const addNb = (a: string, b: string) => { const l = neighbors.get(a); if (l) l.push(b); else neighbors.set(a, [b]); };
    for (const c of connQ.rows) { addNb(c.sourceId, c.targetId); addNb(c.targetId, c.sourceId); }
    const floating = sysRows.filter((r) => !r.locked && !anchoredIds.has(r.id));
    for (let pass = 0; pass < 12; pass++) {
      let progressed = false;
      for (const f of floating) {
        if (placed.has(f.id)) continue;
        const known = (neighbors.get(f.id) ?? []).map((n) => placed.get(n)).filter((p): p is Pt => !!p);
        if (!known.length) continue;
        const mx = known.reduce((s, p) => s + p.x, 0) / known.length;
        const my = known.reduce((s, p) => s + p.y, 0) / known.length;
        placed.set(f.id, { id: f.id, x: mx + BOX_W, y: my + 40 });
        progressed = true;
      }
      if (!progressed) break;
    }
    // Anything still unplaced (disconnected, or a map with no K-space anchors at
    // all) drops into a grid below everything so it's never lost off-canvas.
    const leftover = floating.filter((f) => !placed.has(f.id));
    if (leftover.length) {
      const baseY = (placed.size ? Math.max(...[...placed.values()].map((p) => p.y)) : 0) + BOX_H + GAP;
      const cols = Math.max(1, Math.ceil(Math.sqrt(leftover.length)));
      leftover.forEach((f, k) => placed.set(f.id, { id: f.id, x: MARGIN + (k % cols) * BOX_W, y: baseY + Math.floor(k / cols) * BOX_H }));
    }

    // Final de-overlap over everything (locked stay fixed), then persist the
    // non-locked systems we positioned.
    const all = [...placed.values()];
    deOverlap(all, new Set(lockedPos.keys()));
    const movable = all.filter((p) => !lockedPos.has(p.id));
    for (const p of movable) { p.x = Math.round(p.x); p.y = Math.round(p.y); }
    if (!movable.length) { res.json({ ok: true, repositioned: 0 }); return; }

    const values: string[] = [];
    const params: unknown[] = [mapId];
    let i = 2;
    for (const p of movable) {
      values.push(`($${i}::text, $${i + 1}::float8, $${i + 2}::float8)`);
      params.push(p.id, p.x, p.y);
      i += 3;
    }
    await db.query(
      `UPDATE map_systems AS m
          SET position_x = v.px, position_y = v.py
         FROM (VALUES ${values.join(',')}) AS v(id, px, py)
        WHERE m.id::text = v.id AND m.map_id = $1`,
      params,
    );
    await touchMap(mapId);
    for (const p of movable) {
      publishToMap(mapId, { type: 'system.update', actor: null, id: p.id, updates: { position: { x: p.x, y: p.y } } });
    }
    // Also optimise connection handles for the new positions (runs the client's
    // "optimise connections" server-side, for every client, in one shot).
    await optimizeConnectionHandles(mapId, placed, connQ.rows);
    res.json({ ok: true, repositioned: movable.length });
  } catch (err) {
    log.error(`geographic-layout failed for map ${mapId}:`, err);
    res.status(500).json({ error: 'Layout failed' });
  }
});

// POST /api/maps/:mapId/untangle-layout — one-shot "untangle". A force-directed
// (Fruchterman-Reingold) layout run per connected component: connected systems
// attract, all systems repel, so every system settles ~one hop from its
// neighbours — single-connection "leaf" systems snap right next to theirs — and
// edge crossings drop sharply. Each component is then normalised to a readable
// edge length, de-overlapped, and shelf-packed. Locked systems stay put as fixed
// obstacles; connection handles are re-picked afterwards for the new positions.
mapsRouter.post('/:mapId/untangle-layout', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;
  try {
    const [sysQ, connQ] = await Promise.all([
      db.query<{ id: string; locked: boolean; curX: number | null; curY: number | null }>(
        `SELECT id, locked, position_x AS "curX", position_y AS "curY" FROM map_systems WHERE map_id = $1`,
        [mapId],
      ),
      db.query<{ id: string; sourceId: string; targetId: string; sourceHandle: string | null; targetHandle: string | null }>(
        `SELECT id, source_id AS "sourceId", target_id AS "targetId",
                source_handle AS "sourceHandle", target_handle AS "targetHandle"
           FROM map_connections WHERE map_id = $1`,
        [mapId],
      ),
    ]);
    const sysRows = sysQ.rows;
    if (sysRows.length < 2) { res.json({ ok: true, repositioned: 0 }); return; }

    const K      = 300;             // ideal edge length driving the force sim
    const CUTOFF = 1200;            // ignore repulsion beyond this — keeps the map compact
    const TARGET = 280;             // final edge length after normalisation
    const BOX_W  = 245, BOX_H = 160; // nominal node footprint for de-overlap
    const GAP    = 400;             // padding between packed components
    const MARGIN = 120;
    type Pt = { id: string; x: number; y: number };

    const deOverlap = (nodes: Pt[], fixed?: Set<string>) => {
      for (let iter = 0; iter < 400; iter++) {
        let moved = false;
        for (let a = 0; a < nodes.length; a++) {
          for (let b = a + 1; b < nodes.length; b++) {
            const dx = nodes[b].x - nodes[a].x;
            const dy = nodes[b].y - nodes[a].y;
            const ox = BOX_W - Math.abs(dx);
            const oy = BOX_H - Math.abs(dy);
            if (ox <= 0 || oy <= 0) continue;
            const fa = fixed?.has(nodes[a].id) ?? false;
            const fb = fixed?.has(nodes[b].id) ?? false;
            if (fa && fb) continue;
            const sa = fa ? 0 : (fb ? 1 : 0.5);
            const sb = fb ? 0 : (fa ? 1 : 0.5);
            if (ox < oy) {
              const push = ox * (dx < 0 ? -1 : 1);
              nodes[a].x -= push * sa; nodes[b].x += push * sb;
            } else {
              const push = oy * (dy < 0 ? -1 : 1);
              nodes[a].y -= push * sa; nodes[b].y += push * sb;
            }
            moved = true;
          }
        }
        if (!moved) break;
      }
    };

    // Locked systems are excluded from the untangle (kept at their pinned spot)
    // but act as fixed obstacles in the final de-overlap.
    const lockedPos = new Map<string, Pt>();
    for (const r of sysRows) if (r.locked && r.curX != null && r.curY != null) lockedPos.set(r.id, { id: r.id, x: r.curX, y: r.curY });
    const movableIds = sysRows.filter((r) => !r.locked).map((r) => r.id);
    const movableSet = new Set(movableIds);

    // Adjacency over movable systems only.
    const adj = new Map<string, string[]>();
    for (const id of movableIds) adj.set(id, []);
    for (const c of connQ.rows) {
      if (movableSet.has(c.sourceId) && movableSet.has(c.targetId)) {
        adj.get(c.sourceId)!.push(c.targetId);
        adj.get(c.targetId)!.push(c.sourceId);
      }
    }

    // Connected components via union-find.
    const parent = new Map<string, string>(movableIds.map((id) => [id, id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
      return r;
    };
    for (const id of movableIds) for (const nb of adj.get(id)!) if (id < nb) parent.set(find(id), find(nb));
    const groups = new Map<string, string[]>();
    for (const id of movableIds) { const r = find(id); const g = groups.get(r); if (g) g.push(id); else groups.set(r, [id]); }

    // Force-directed (Fruchterman-Reingold) layout of one component: repulsion
    // spreads all systems apart, edge springs pull neighbours to ~one hop, then
    // normalise so the median edge length is TARGET, de-overlap, and translate to
    // a (0,0) origin. Returns positions + block size for packing.
    const layoutComponent = (ids: string[]): { pos: Pt[]; w: number; h: number } => {
      const N = ids.length;
      const idx = new Map(ids.map((id, i) => [id, i]));
      const GA = Math.PI * (3 - Math.sqrt(5)); // golden-angle spiral seed (deterministic)
      const P: (Pt & { dx: number; dy: number })[] = ids.map((id, i) => {
        const r = K * 0.6 * Math.sqrt(i + 1);
        return { id, x: Math.cos(i * GA) * r, y: Math.sin(i * GA) * r, dx: 0, dy: 0 };
      });
      if (N > 1) {
        let temp = K * 1.6;
        for (let it = 0; it < 700; it++) {
          for (const p of P) { p.dx = 0; p.dy = 0; }
          for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
            const dx = P[a].x - P[b].x, dy = P[a].y - P[b].y, d = Math.hypot(dx, dy) || 0.01;
            if (d > CUTOFF) continue; // distant nodes don't repel — stops the layout ballooning
            const f = (K * K) / d, ux = dx / d, uy = dy / d;
            P[a].dx += ux * f; P[a].dy += uy * f; P[b].dx -= ux * f; P[b].dy -= uy * f;
          }
          for (const id of ids) for (const nb of adj.get(id)!) if (id < nb) {
            const A = P[idx.get(id)!], B = P[idx.get(nb)!];
            const dx = A.x - B.x, dy = A.y - B.y, d = Math.hypot(dx, dy) || 0.01;
            const f = (d * d) / K, ux = dx / d, uy = dy / d;
            A.dx -= ux * f; A.dy -= uy * f; B.dx += ux * f; B.dy += uy * f;
          }
          for (const p of P) { p.dx += -p.x * 0.015; p.dy += -p.y * 0.015; } // mild centring gravity
          for (const p of P) { const d = Math.hypot(p.dx, p.dy) || 0.01; p.x += (p.dx / d) * Math.min(d, temp); p.y += (p.dy / d) * Math.min(d, temp); }
          temp *= 0.992;
        }
        // Normalise so the median edge length is TARGET (uniform scale preserves
        // the crossing count and the shape).
        const el: number[] = [];
        for (const id of ids) for (const nb of adj.get(id)!) if (id < nb) {
          const A = P[idx.get(id)!], B = P[idx.get(nb)!];
          el.push(Math.hypot(A.x - B.x, A.y - B.y));
        }
        el.sort((a, b) => a - b);
        const med = el.length ? el[el.length >> 1] : TARGET;
        const s = med > 0 ? TARGET / med : 1;
        for (const p of P) { p.x *= s; p.y *= s; }
      }
      deOverlap(P);
      const nx = Math.min(...P.map((p) => p.x)), ny = Math.min(...P.map((p) => p.y));
      const pos = P.map((p) => ({ id: p.id, x: Math.round(p.x - nx), y: Math.round(p.y - ny) }));
      const w = Math.max(...P.map((p) => p.x)) - nx + BOX_W;
      const h = Math.max(...P.map((p) => p.y)) - ny + BOX_H;
      return { pos, w, h };
    };

    const blobs = [...groups.values()].map(layoutComponent);

    // Shelf-pack the components into a compact ~square.
    blobs.sort((a, b) => b.h - a.h);
    const targetW = Math.max(BOX_W, Math.sqrt(blobs.reduce((s, b) => s + b.w * b.h, 0)) * 1.4);
    const placed = new Map<string, Pt>();
    let cx = 0, cy = 0, rowH = 0;
    for (const bl of blobs) {
      if (cx > 0 && cx + bl.w > targetW) { cx = 0; cy += rowH + GAP; rowH = 0; }
      for (const p of bl.pos) placed.set(p.id, { id: p.id, x: p.x + cx + MARGIN, y: p.y + cy + MARGIN });
      cx += bl.w + GAP; rowH = Math.max(rowH, bl.h);
    }
    for (const p of lockedPos.values()) placed.set(p.id, p);

    const all = [...placed.values()];
    deOverlap(all, new Set(lockedPos.keys()));
    const movable = all.filter((p) => !lockedPos.has(p.id));
    for (const p of movable) { p.x = Math.round(p.x); p.y = Math.round(p.y); }
    if (!movable.length) { res.json({ ok: true, repositioned: 0 }); return; }

    const values: string[] = [];
    const params: unknown[] = [mapId];
    let i = 2;
    for (const p of movable) {
      values.push(`($${i}::text, $${i + 1}::float8, $${i + 2}::float8)`);
      params.push(p.id, p.x, p.y);
      i += 3;
    }
    await db.query(
      `UPDATE map_systems AS m
          SET position_x = v.px, position_y = v.py
         FROM (VALUES ${values.join(',')}) AS v(id, px, py)
        WHERE m.id::text = v.id AND m.map_id = $1`,
      params,
    );
    await touchMap(mapId);
    for (const p of movable) {
      publishToMap(mapId, { type: 'system.update', actor: null, id: p.id, updates: { position: { x: p.x, y: p.y } } });
    }
    // Also optimise connection handles for the new positions (runs the client's
    // "optimise connections" server-side, for every client, in one shot).
    await optimizeConnectionHandles(mapId, placed, connQ.rows);
    res.json({ ok: true, repositioned: movable.length });
  } catch (err) {
    log.error(`untangle-layout failed for map ${mapId}:`, err);
    res.status(500).json({ error: 'Layout failed' });
  }
});

mapsRouter.patch('/:mapId/connections/:connectionId', async (req, res) => {
  const { mapId, connectionId } = req.params;

  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  const colMap: Record<string, string> = {
    connectionType: 'connection_type', massStatus: 'mass_status',
    timeStatus: 'time_status', size: 'size',
    sourceHandle: 'source_handle', targetHandle: 'target_handle',
    type: 'wh_type', massUsed: 'mass_used',
    eolAt: 'eol_at', lifetimeExpiresAt: 'lifetime_expires_at', broken: 'broken',
    flagIcon: 'flag_icon', flagNote: 'flag_note', flagBlink: 'flag_blink', flagColor: 'flag_color',
    sourceSignatureId: 'source_signature_id', targetSignatureId: 'target_signature_id',
  };

  const updates: Record<string, unknown> = { ...(req.body as Record<string, unknown>) };

  // Validate the two time-bucket fields. The whitelist below trusts values
  // verbatim, so reject anything malformed here (a bad ISO string would 22007
  // the UPDATE and 500 the request; an unknown time_status would corrupt the
  // edge state read by every client).
  if ('timeStatus' in updates) {
    const v = updates.timeStatus;
    const VALID = ['fresh', 'eol', 'lessThan24h', 'lessThan4h', 'lessThan1h', 'expired'];
    if (v !== null && (typeof v !== 'string' || !VALID.includes(v))) {
      res.status(400).json({ error: 'invalid timeStatus' }); return;
    }
  }
  if ('lifetimeExpiresAt' in updates) {
    const v = updates.lifetimeExpiresAt;
    if (v !== null && (typeof v !== 'string' || Number.isNaN(Date.parse(v)))) {
      res.status(400).json({ error: 'invalid lifetimeExpiresAt' }); return;
    }
  }
  // Connection flag: a Phosphor icon export name (short) + a free-text note.
  // Both are stored verbatim below, so bound the lengths here — an unbounded
  // note would let one client bloat every viewer's map payload.
  if ('flagIcon' in updates) {
    const v = updates.flagIcon;
    if (v !== null && (typeof v !== 'string' || v.length > 64)) {
      res.status(400).json({ error: 'invalid flagIcon' }); return;
    }
  }
  if ('flagNote' in updates) {
    const v = updates.flagNote;
    if (v !== null && (typeof v !== 'string' || v.length > 200)) {
      res.status(400).json({ error: 'invalid flagNote' }); return;
    }
  }
  if ('flagBlink' in updates && typeof updates.flagBlink !== 'boolean') {
    res.status(400).json({ error: 'invalid flagBlink' }); return;
  }
  // Flag colour goes into an inline CSS custom property on the edge, so require
  // a plain #rrggbb hex (rejecting anything that could smuggle other CSS).
  if ('flagColor' in updates) {
    const v = updates.flagColor;
    if (v !== null && (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v))) {
      res.status(400).json({ error: 'invalid flagColor' }); return;
    }
  }

  // The stored size should follow the hole type. When the wormhole type is set
  // without an explicit size — wormhole auto-detect and external API writes both
  // send `type` alone — derive the nominal size class from the type so a Q003 is
  // stored as 'small' instead of the 'large' insert-time default. An explicit
  // client size (e.g. a manual override) is always respected.
  if ('type' in updates && !('size' in updates)) {
    const derived = await whSizeForCode(updates.type as string | null);
    if (derived) updates.size = derived;
  }

  // When the wormhole type is (re)identified, stamp the current time bucket so
  // the stored status is right immediately — otherwise it stays stale until the
  // next hourly connLifetimeSweep and the right-click menu / scout list disagree
  // with the live edge label. Skip if the client already sent an explicit
  // timeStatus (a manual pick owns it).
  if ('type' in updates && !('timeStatus' in updates)) {
    try {
      const cur = await db.query<{ createdAt: Date; eolAt: Date | null; lifetimeExpiresAt: Date | null }>(
        `SELECT created_at AS "createdAt", eol_at AS "eolAt", lifetime_expires_at AS "lifetimeExpiresAt"
           FROM map_connections WHERE id = $1 AND map_id = $2`,
        [connectionId, mapId],
      );
      const row = cur.rows[0];
      if (row) {
        const expiry = effectiveExpiryMs({
          lifetimeExpiresAt: row.lifetimeExpiresAt,
          eolAt:             row.eolAt,
          whType:            updates.type as string | null,
          createdAt:         row.createdAt,
        });
        if (expiry != null) updates.timeStatus = lifeBucket(expiry - Date.now());
      }
    } catch { /* leave time_status as-is on any lookup failure */ }
  }

  const sets: string[] = [];
  const vals: unknown[] = [];

  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) {
      sets.push(`${col} = $${vals.length + 1}`);
      vals.push(updates[key]);
    }
  }

  if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }

  await db.query(
    `UPDATE map_connections SET ${sets.join(', ')} WHERE id = $${vals.length + 1} AND map_id = $${vals.length + 2}`,
    [...vals, connectionId, mapId],
  );
  await touchMap(mapId);
  publishToMap(mapId, { type: 'connection.update', actor: req.get('x-client-id') ?? null, id: connectionId, updates });
  // A wormhole type was just filled in — e.g. sig auto-detect labelling a
  // manually-drawn connection once its hole is scanned. Re-check the broadcast;
  // it's deduped, so a connection already announced won't fire again.
  if (typeof updates.type === 'string' && updates.type.trim() !== '') {
    maybeBroadcastConnection(access, mapId, connectionId, req.session.characterName ?? null);
  }
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/connections/:connectionId', async (req, res) => {
  const { mapId, connectionId } = req.params;
  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;
  await db.query(`DELETE FROM map_connections WHERE id = $1 AND map_id = $2`, [connectionId, mapId]);
  await touchMap(mapId);
  publishToMap(mapId, { type: 'connection.remove', actor: req.get('x-client-id') ?? null, id: connectionId });
  res.json({ ok: true });
});

// ── Connection jump log ─────────────────────────────────────────────────────────
// A passive, shared record of known ships that have physically jumped through a
// connection — intel for eyeballing the mass that's gone through. It NEVER
// mutates the connection's mass_used (that's the rolling calculator). Read is any
// map viewer; write is content-level (mirrors signatures) so a readonly / view-only
// share can't post. Ship name/class/base mass are resolved server-side from the
// SDE; the pilot identity is derived from the session (or one of the caller's own
// characters), never trusted from the body.

// Resolve the acting pilot's EVE character id + name. `actingCharId` (a users.id
// the client is following, e.g. a pinned alt) is honoured ONLY when it belongs to
// the caller's own account, so a jump can never be attributed to someone else's
// pilot; otherwise it falls back to the session character.
async function resolveActingPilot(
  sessionUserId: number, actingCharId: unknown,
): Promise<{ characterId: number | null; characterName: string | null }> {
  const raw = Number(actingCharId);
  if (Number.isInteger(raw) && raw > 0 && raw !== sessionUserId) {
    const { rows } = await db.query<{ characterId: number | null; characterName: string | null }>(
      `SELECT character_id AS "characterId", character_name AS "characterName"
         FROM users u
        WHERE u.id = $1
          AND ( u.id = $2 OR u.owner_id = (SELECT owner_id FROM users WHERE id = $2) )`,
      [raw, sessionUserId],
    );
    if (rows.length) return rows[0];
  }
  const { rows } = await db.query<{ characterId: number | null; characterName: string | null }>(
    `SELECT character_id AS "characterId", character_name AS "characterName" FROM users WHERE id = $1`,
    [sessionUserId],
  );
  return rows[0] ?? { characterId: null, characterName: null };
}

mapsRouter.get('/:mapId/connections/:connectionId/jumps', async (req, res) => {
  const { mapId, connectionId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  if (!(await verifyConnectionInMap(res, connectionId, mapId))) return;
  res.json(await listConnectionJumps(connectionId));
});

mapsRouter.post('/:mapId/connections/:connectionId/jumps', async (req, res) => {
  const { mapId, connectionId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifyConnectionInMap(res, connectionId, mapId))) return;

  const body = req.body as {
    shipTypeId?: unknown; direction?: unknown; actingCharId?: unknown;
    fromEveSystemId?: unknown; toEveSystemId?: unknown;
  };
  const posInt = (v: unknown): number | null =>
    Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
  const shipTypeId = posInt(body.shipTypeId);
  const direction: 'forward' | 'reverse' = body.direction === 'reverse' ? 'reverse' : 'forward';
  const pilot = await resolveActingPilot(req.session.userId!, body.actingCharId);

  const jump = await recordConnectionJump({
    mapId, connectionId, direction,
    fromEveSystemId: posInt(body.fromEveSystemId), toEveSystemId: posInt(body.toEveSystemId),
    characterId: pilot.characterId, characterName: pilot.characterName, shipTypeId,
  });
  publishToMap(mapId, { type: 'jump.logged', actor: req.get('x-client-id') ?? null, connectionId, jump });
  res.status(201).json(jump);
});

// PATCH one logged crossing — currently just the hot/cold flag, set by a viewer
// who knows whether that pilot's prop was active. Content-level write.
mapsRouter.patch('/:mapId/connections/:connectionId/jumps/:jumpId', async (req, res) => {
  const { mapId, connectionId, jumpId } = req.params;
  if (!UUID_RE.test(jumpId)) { res.status(404).json({ error: 'Jump not found' }); return; }
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifyConnectionInMap(res, connectionId, mapId))) return;

  const hot = (req.body as { hot?: unknown }).hot;
  if (typeof hot !== 'boolean') { res.status(400).json({ error: 'hot must be a boolean' }); return; }
  const jump = await setConnectionJumpHot(jumpId, connectionId, mapId, hot);
  if (!jump) { res.status(404).json({ error: 'Jump not found' }); return; }
  publishToMap(mapId, { type: 'jump.updated', actor: req.get('x-client-id') ?? null, connectionId, jump });
  res.json(jump);
});

mapsRouter.delete('/:mapId/connections/:connectionId/jumps', async (req, res) => {
  const { mapId, connectionId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifyConnectionInMap(res, connectionId, mapId))) return;
  await clearConnectionJumps(connectionId, mapId);
  publishToMap(mapId, { type: 'jump.cleared', actor: req.get('x-client-id') ?? null, connectionId });
  res.json({ ok: true });
});

// ── Saved chains (routes) ──────────────────────────────────────────────────────
// A chain is a named, recorded path A..B through the map's own connections.
// Content-level permission (like signatures): it annotates the map, it doesn't
// mutate topology. The step arrays are stored verbatim and validated against the
// live map when rendered, so a removed hop is flagged rather than re-routed.

const routeSelect =
  `SELECT id, name, system_ids AS "systemIds", connection_ids AS "connectionIds",
          created_at AS "createdAt", updated_at AS "updatedAt"
     FROM map_routes`;

mapsRouter.post('/:mapId/routes', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  const { id, name = '', systemIds = [], connectionIds = [] } = req.body as {
    id?: string; name?: string; systemIds?: string[]; connectionIds?: string[];
  };
  if (!id || !Array.isArray(systemIds) || systemIds.length < 2) {
    res.status(400).json({ error: 'A chain needs an id and at least two systems' });
    return;
  }
  const me = authUser(req);
  // New chains append to the bottom of the list (next sort_order for the map).
  const ins = await db.query(
    `INSERT INTO map_routes (id, map_id, name, system_ids, connection_ids, created_by_user_id, sort_order)
     SELECT $1,$2,$3,$4,$5,$6, COALESCE(MAX(sort_order) + 1, 0) FROM map_routes WHERE map_id = $2
     ON CONFLICT (id) DO NOTHING`,
    [id, mapId, name, systemIds, connectionIds ?? [], me.userId],
  );
  await touchMap(mapId);
  // Only a genuinely new row broadcasts — a retried POST hits ON CONFLICT DO
  // NOTHING (rowCount 0), so we don't double-post the same chain to Discord.
  const inserted = (ins.rowCount ?? 0) > 0;
  db.query(`${routeSelect} WHERE id = $1 AND map_id = $2`, [id, mapId])
    .then(({ rows }) => {
      const route = rows[0] as { name: string; systemIds: string[]; connectionIds: string[] } | undefined;
      if (!route) return;
      publishToMap(mapId, { type: 'route.add', actor: req.get('x-client-id') ?? null, route });
      // Notify Discord that a chain was saved (corp/alliance maps only; gated by
      // the org's settings). Best-effort — never blocks or fails the save.
      if (inserted) dispatchChainSaved(access, mapId, route, req.session.characterName ?? null);
    }).catch(console.error);
  res.status(201).json({ ok: true });
});

mapsRouter.patch('/:mapId/routes/:routeId', async (req, res) => {
  const { mapId, routeId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  const colMap: Record<string, string> = {
    name: 'name', systemIds: 'system_ids', connectionIds: 'connection_ids',
  };
  const updates = req.body as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(colMap)) {
    if (key in updates) { sets.push(`${col} = $${vals.length + 1}`); vals.push(updates[key]); }
  }
  if (!sets.length) { res.status(400).json({ error: 'Nothing to update' }); return; }
  await db.query(
    `UPDATE map_routes SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length + 1} AND map_id = $${vals.length + 2}`,
    [...vals, routeId, mapId],
  );
  await touchMap(mapId);
  publishToMap(mapId, { type: 'route.update', actor: req.get('x-client-id') ?? null, id: routeId, updates });
  res.json({ ok: true });
});

// Persist a drag-and-drop reorder of the chains list. Writes sort_order = the
// position in `orderedIds` for every chain that belongs to the map; ids not in
// the map are ignored, ids omitted keep their old sort_order (harmless tie).
mapsRouter.put('/:mapId/routes/order', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  const { orderedIds } = req.body as { orderedIds?: string[] };
  if (!Array.isArray(orderedIds) || !orderedIds.length) {
    res.status(400).json({ error: 'orderedIds must be a non-empty array' });
    return;
  }
  await db.query(
    `UPDATE map_routes AS r
        SET sort_order = o.ord - 1, updated_at = NOW()
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, ord)
      WHERE r.id = o.id AND r.map_id = $2`,
    [orderedIds, mapId],
  );
  await touchMap(mapId);
  publishToMap(mapId, { type: 'route.reorder', actor: req.get('x-client-id') ?? null, orderedIds });
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/routes/:routeId', async (req, res) => {
  const { mapId, routeId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  await db.query(`DELETE FROM map_routes WHERE id = $1 AND map_id = $2`, [routeId, mapId]);
  await touchMap(mapId);
  publishToMap(mapId, { type: 'route.remove', actor: req.get('x-client-id') ?? null, id: routeId });
  res.json({ ok: true });
});

// ── Signatures ────────────────────────────────────────────────────────────────

mapsRouter.get('/:mapId/systems/:systemId/signatures', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  res.json(await loadSystemSignatures(systemId));
});

mapsRouter.post('/:mapId/systems/:systemId/signatures', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  const { sigId = '', sigType = 'unknown', name = '', notes = '', whType = '', whLeadsTo = '' } = req.body as Record<string, string>;
  const me = authUser(req);
  const row = await createSignature(
    mapId, systemId, { sigId, sigType, name, notes, whType, whLeadsTo },
    { userId: me.userId, clientId: req.get('x-client-id') ?? null },
  );
  if ((whType ?? '').toUpperCase() === 'K162') dispatchK162(access, row.id, systemId, me.characterName);
  res.status(201).json(row);
});

mapsRouter.patch('/:mapId/systems/:systemId/signatures/:sigId', async (req, res) => {
  const { mapId, systemId, sigId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;

  const updates = req.body as Record<string, unknown>;
  const me = authUser(req);
  const { dispatchK162: shouldDispatch, flushK162: shouldFlush } = await updateSignature(
    mapId, systemId, sigId, updates, { userId: me.userId, clientId: req.get('x-client-id') ?? null },
  );
  // Discord notice fires once on a transition into K162; flush any pending
  // notice the moment the leads-to is known. (Both decided inside updateSignature.)
  if (shouldDispatch) dispatchK162(access, sigId, systemId, me.characterName);
  if (shouldFlush) flushK162(sigId);
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/systems/:systemId/signatures/:sigId', async (req, res) => {
  const { mapId, systemId, sigId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  await deleteSignature(mapId, systemId, sigId, { userId: authUser(req).userId, clientId: req.get('x-client-id') ?? null });
  res.json({ ok: true });
});

// Lightweight map-wide index of scanned signatures, so the client can match
// content anywhere in the chain without opening every system's sig pane —
// powers the watchlist (wh_type matching) and the content filter (sig type +
// name). Returns only the (systemId, sigType, name, whType) tuple per sig.
mapsRouter.get('/:mapId/signatures', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  const { rows } = await db.query(
    `SELECT s.id, s.sig_id AS "sigId", s.system_id AS "systemId", s.sig_type AS "sigType",
            s.name, s.wh_type AS "whType", s.wh_leads_to AS "whLeadsTo"
     FROM map_signatures s
     JOIN map_systems ms ON ms.id = s.system_id
     WHERE ms.map_id = $1`,
    [mapId],
  );
  res.json(rows);
});

// Map-wide index of scanned anomalies (systemId, anomType, name) for the
// content filter — the anomaly counterpart of the bulk /signatures route.
mapsRouter.get('/:mapId/anomalies', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  const { rows } = await db.query(
    `SELECT a.system_id AS "systemId", a.anom_type AS "anomType", a.name
     FROM map_anomalies a
     JOIN map_systems ms ON ms.id = a.system_id
     WHERE ms.map_id = $1`,
    [mapId],
  );
  res.json(rows);
});

// ── Anomalies ─────────────────────────────────────────────────────────────────
// Cosmic anomalies pasted from the probe scanner. Same shape as the signature
// routes but simpler: no wormhole type / leads-to, no K162 dispatch, no ghost
// site recording, and they don't back map connections.

mapsRouter.get('/:mapId/systems/:systemId/anomalies', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  res.json(await loadSystemAnomalies(systemId));
});

mapsRouter.post('/:mapId/systems/:systemId/anomalies', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  const { anomId = '', anomType = 'unknown', name = '', notes = '' } = req.body as Record<string, string>;
  const row = await createAnomaly(mapId, systemId, { anomId, anomType, name, notes },
    { userId: authUser(req).userId, clientId: req.get('x-client-id') ?? null });
  res.status(201).json(row);
});

mapsRouter.patch('/:mapId/systems/:systemId/anomalies/:anomId', async (req, res) => {
  const { mapId, systemId, anomId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;

  const updates = req.body as Record<string, unknown>;
  await updateAnomaly(mapId, systemId, anomId, updates,
    { userId: authUser(req).userId, clientId: req.get('x-client-id') ?? null });
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/systems/:systemId/anomalies/:anomId', async (req, res) => {
  const { mapId, systemId, anomId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  await deleteAnomaly(mapId, systemId, anomId, { userId: authUser(req).userId, clientId: req.get('x-client-id') ?? null });
  res.json({ ok: true });
});

// ── Structures (manual player structures) ─────────────────────────────────────

mapsRouter.get('/:mapId/systems/:systemId/structures', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  res.json(await loadSystemStructures(systemId));
});

mapsRouter.post('/:mapId/systems/:systemId/structures', async (req, res) => {
  const { mapId, systemId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  const { name = '', structureType = 'unknown', ownerCorp = '', notes = '', eveId = null } = req.body as Record<string, string>;
  const eveIdNum = eveId ? Number(eveId) : null;
  const me = authUser(req);

  // Block briefly on ESI to resolve the owner corp when an eve_id is
  // supplied. If the call fails (private structure / missing scope /
  // bad ID) we just leave owner_corp_id NULL — the row still goes in.
  const ownerCorpId = eveIdNum ? await resolveStructureOwnerCorp(me.userId, eveIdNum) : null;

  const row = await createStructure(mapId, systemId,
    { name, structureType, ownerCorp, notes, eveId: eveIdNum, ownerCorpId },
    { userId: me.userId, clientId: req.get('x-client-id') ?? null });
  res.status(201).json(row);
});

mapsRouter.patch('/:mapId/systems/:systemId/structures/:structureId', async (req, res) => {
  const { mapId, systemId, structureId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;

  const updates = req.body as Record<string, unknown>;
  await updateStructure(mapId, systemId, structureId, updates,
    { userId: authUser(req).userId, clientId: req.get('x-client-id') ?? null });
  res.json({ ok: true });
});

mapsRouter.delete('/:mapId/systems/:systemId/structures/:structureId', async (req, res) => {
  const { mapId, systemId, structureId } = req.params;
  const access = await requireMapContentWrite(res, mapId, req);
  if (!access) return;
  if (!(await verifySystemInMap(res, systemId, mapId))) return;
  await deleteStructure(mapId, systemId, structureId, { userId: authUser(req).userId, clientId: req.get('x-client-id') ?? null });
  res.json({ ok: true });
});

// ── Share links ───────────────────────────────────────────────────────────────

// Sharing has stricter permissions than editing. Anyone with edit access can
// modify a corp map, but only an admin can hand out a public read-only link.
// Personal maps still belong to their owner — only they can share.
async function requireShareAdmin(res: Response, mapId: string, req: Request): Promise<MapMeta | null> {
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return null; }

  const role = req.session.role ?? 'readonly';
  const userId = req.session.userId!;
  const isCorpMap = access.corpId !== null
    && ((config.corpMode && config.corpIds.includes(access.corpId)) || config.allianceMode);
  const isAllianceMap = config.allianceMode
    && access.allianceId !== null
    && config.allianceIds.includes(access.allianceId);

  if (isAllianceMap) {
    if (!isAllianceAdmin(role)) {
      res.status(403).json({ error: 'Only an alliance admin can share an alliance map' });
      return null;
    }
  } else if (isCorpMap) {
    if (!isAdmin(role)) {
      res.status(403).json({ error: 'Only an admin can share a corp map' });
      return null;
    }
  } else if (access.userId !== userId) {
    res.status(403).json({ error: 'Only the owner can share this map' });
    return null;
  }
  return access;
}

// Allowed expiry windows for share links (in hours). Anything outside
// the allowlist falls back to the default — a user can't extend a link
// indefinitely by passing 99999.
const SHARE_EXPIRY_HOURS_ALLOWED = new Set([1, 12, 24, 72, 168]);
const SHARE_EXPIRY_DEFAULT_HOURS = 24;

// POST /api/maps/:mapId/share
// Generates a fresh share token (or replaces an existing one). One token
// per map by design — regenerate to rotate. Returns the full share URL
// ready to copy to clipboard.
//
// Body: { includeSigs?, includeBridges?, includeNotes?, includeStructures?, expiryHours? }
//   includeSigs       — return sigs per system. Sigs are intel.
//   includeBridges    — return connections typed 'jumpgate' (player JBs).
//   includeNotes      — return system notes. Often intel.
//   includeStructures — return structures pane data. Always intel.
//   expiryHours       — link lifetime; must be in SHARE_EXPIRY_HOURS_ALLOWED.
// All booleans default to FALSE so a freshly-issued link starts neutral.
mapsRouter.post('/:mapId/share', async (req, res) => {
  const { mapId } = req.params;
  if (!(await requireShareAdmin(res, mapId, req))) return;

  const includeSigs       = req.body?.includeSigs       === true;
  const includeBridges    = req.body?.includeBridges    === true;
  const includeNotes      = req.body?.includeNotes      === true;
  const includeStructures = req.body?.includeStructures === true;
  const requestedHours    = Number(req.body?.expiryHours);
  const expiryHours       = SHARE_EXPIRY_HOURS_ALLOWED.has(requestedHours)
    ? requestedHours
    : SHARE_EXPIRY_DEFAULT_HOURS;

  const token = crypto.randomUUID();
  // make_interval lets us parameterise the duration safely — interpolating
  // the integer into the SQL string would otherwise be the only option,
  // since INTERVAL literals can't take a placeholder directly.
  const { rows } = await db.query<{ expiresAt: string }>(
    `UPDATE maps
        SET share_token              = $1,
            share_expires_at         = NOW() + make_interval(hours => $5),
            share_include_sigs       = $3,
            share_include_bridges    = $4,
            share_include_notes      = $6,
            share_include_structures = $7
      WHERE id = $2
      RETURNING share_expires_at AS "expiresAt"`,
    [token, mapId, includeSigs, includeBridges, expiryHours, includeNotes, includeStructures],
  );
  const origin = (process.env.FRONTEND_URL ?? '').replace(/\/+$/, '');
  res.json({
    token,
    url:               `${origin}/#/share/${token}`,
    expiresAt:         rows[0]?.expiresAt ?? null,
    includeSigs,
    includeBridges,
    includeNotes,
    includeStructures,
    expiryHours,
  });
});

// PATCH /api/maps/:mapId/share
// Update an existing share link's options without regenerating the token.
// Body accepts any subset of: includeSigs, includeBridges, includeNotes,
// includeStructures. Only fields that are present are applied. No-op
// when there isn't an active token. Expiry is *not* PATCHable — extend
// requires revoke + regenerate so a leaked URL can't be quietly extended.
mapsRouter.patch('/:mapId/share', async (req, res) => {
  const { mapId } = req.params;
  if (!(await requireShareAdmin(res, mapId, req))) return;

  const COLS: Record<string, string> = {
    includeSigs:       'share_include_sigs',
    includeBridges:    'share_include_bridges',
    includeNotes:      'share_include_notes',
    includeStructures: 'share_include_structures',
  };
  const sets: string[] = [];
  const values: unknown[] = [mapId];
  for (const [key, col] of Object.entries(COLS)) {
    if (typeof req.body?.[key] === 'boolean') {
      values.push(req.body[key]);
      sets.push(`${col} = $${values.length}`);
    }
  }
  if (sets.length === 0) { res.json({ ok: true }); return; }

  await db.query(
    `UPDATE maps SET ${sets.join(', ')} WHERE id = $1 AND share_token IS NOT NULL`,
    values,
  );
  res.json({ ok: true });
});

// DELETE /api/maps/:mapId/share
mapsRouter.delete('/:mapId/share', async (req, res) => {
  const { mapId } = req.params;
  if (!(await requireShareAdmin(res, mapId, req))) return;
  await db.query(
    `UPDATE maps SET share_token = NULL, share_expires_at = NULL WHERE id = $1`,
    [mapId],
  );
  res.json({ ok: true });
});

// ── Per-user / per-corp share grants ──────────────────────────────────────────
//
// Separate from the public share-link feature above: these grants give
// edit access to a specific EVE character or to every member of a specific
// corp. Personal maps only — corp maps are by definition already shared
// via corp membership.

const MAX_SHARES_PER_MAP = 50;

// GET /api/maps/:mapId/shares — list current grants. Personal maps: owner only;
// corp/alliance maps: an admin / alliance-admin of the owning org (requireShareAdmin).
// Returns the EVE id, target kind, edit flag, when it was granted, and a resolved
// human-readable name so the picker UI doesn't have to fan out to ESI.
mapsRouter.get('/:mapId/shares', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireShareAdmin(res, mapId, req);
  if (!access) return;

  const { rows } = await db.query<{
    id: string;
    targetCharacterId: number | null;
    targetCorpId:      number | null;
    targetAllianceId:  number | null;
    canWrite:          boolean;
    createdAt:         string;
  }>(
    `SELECT id,
            target_character_id AS "targetCharacterId",
            target_corp_id      AS "targetCorpId",
            target_alliance_id  AS "targetAllianceId",
            can_write           AS "canWrite",
            created_at          AS "createdAt"
       FROM map_shares
      WHERE map_id = $1
      ORDER BY created_at`,
    [mapId],
  );

  // Resolve all referenced EVE ids in a single batched call.
  const ids = rows.flatMap((r) => [r.targetCharacterId, r.targetCorpId, r.targetAllianceId])
    .filter((x): x is number => x != null);
  const names = await resolveEntityNames(ids);

  res.json({
    shares: rows.map((r) => {
      const kind = r.targetCharacterId != null ? 'character' : r.targetCorpId != null ? 'corp' : 'alliance';
      const targetId = (r.targetCharacterId ?? r.targetCorpId ?? r.targetAllianceId)!;
      return { id: r.id, kind, targetId, name: names.get(targetId)?.name ?? null, canWrite: r.canWrite, createdAt: r.createdAt };
    }),
  });
});

// POST /api/maps/:mapId/shares — grant create. Personal maps: owner only;
// corp/alliance maps: an admin / alliance-admin of the owning org.
// Body: { kind: 'character' | 'corp' | 'alliance', targetId: number, canWrite?: boolean, alsoGrantLogin?: boolean }
// Returns the resolved name + canonical row so the client can show it
// immediately without re-fetching the whole list.
mapsRouter.post('/:mapId/shares', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireShareAdmin(res, mapId, req);
  if (!access) return;

  const { kind, targetId, alsoGrantLogin, canWrite } = req.body as { kind?: unknown; targetId?: unknown; alsoGrantLogin?: unknown; canWrite?: unknown };
  // Default to edit (true) when unspecified, matching the historical share
  // behaviour for personal maps; the UI sends an explicit boolean.
  const grantCanWrite = canWrite === undefined ? true : canWrite === true;
  if (kind !== 'character' && kind !== 'corp' && kind !== 'alliance') {
    res.status(400).json({ error: 'kind must be "character", "corp", or "alliance"' });
    return;
  }
  const idNum = Number(targetId);
  if (!Number.isInteger(idNum) || idNum <= 0 || idNum > 2_147_483_647) {
    res.status(400).json({ error: 'targetId must be a positive integer' });
    return;
  }
  // Alliance targets only exist on an alliance installation.
  if (!grantKindAllowedForInstall(kind)) {
    res.status(400).json({ error: 'alliance_not_supported', message: 'Alliance sharing is only available on an alliance installation.' });
    return;
  }

  // Self-share guard: owner can't grant their own character access (they
  // already have it). Cheap because we already loaded their character_id
  // shape in getMapAccess implicitly — but cheaper to just compare the
  // user_id we have on `access`.
  if (kind === 'character') {
    const { rows } = await db.query<{ characterId: number }>(
      `SELECT character_id AS "characterId" FROM users WHERE id = $1`,
      [req.session.userId],
    );
    if (rows[0]?.characterId === idNum) {
      res.status(400).json({ error: 'You already have access to this map' });
      return;
    }
  }

  // Positive-standing prerequisite (design 4.0): a restricted deployment may
  // only share with a CORP/ALLIANCE it holds at positive standing. Individual
  // characters are exempt (a deliberate 1:1 grant). Solo/unrestricted installs
  // have no standings to check, so the gate is skipped there too.
  if (config.restrictedMode && requiresPositiveStanding(kind) && !(await standingPermitsTarget(kind, idNum))) {
    res.status(403).json({
      error: 'standing_not_positive',
      message: 'Your deployment does not hold this entity at positive standing (contacts must be synced and standing must be > 0).',
    });
    return;
  }

  // Granting login access widens the deployment's login allow-list. corp/alliance
  // targets are validated by the positive-standing gate above; an individual
  // CHARACTER grant has no such gate (requiresPositiveStanding is false for
  // characters), so restrict it to admins — matching the admin-only allow-list
  // endpoint. Without this, any member (even readonly) could self-admit an
  // arbitrary character into a restricted deployment via a map share.
  if (alsoGrantLogin === true && config.restrictedMode && kind === 'character'
      && !isAdmin(req.session.role ?? 'readonly')) {
    res.status(403).json({
      error: 'forbidden',
      message: 'Only an admin can grant login access to an individual character.',
    });
    return;
  }

  // Enforce a hard ceiling so a runaway client can't pile thousands of
  // grants onto one map.
  const { rowCount: existing } = await db.query(
    `SELECT 1 FROM map_shares WHERE map_id = $1`,
    [mapId],
  );
  if ((existing ?? 0) >= MAX_SHARES_PER_MAP) {
    res.status(403).json({ error: `Maximum shares per map reached (${MAX_SHARES_PER_MAP})` });
    return;
  }

  // Target column by kind — a fixed whitelist keyed by the validated `kind`,
  // so this is not user-controlled SQL.
  const targetCol = { character: 'target_character_id', corp: 'target_corp_id', alliance: 'target_alliance_id' }[kind];

  try {
    const { rows } = await db.query<{ id: string; createdAt: string }>(
      `INSERT INTO map_shares (map_id, ${targetCol}, granted_by_user_id, can_write)
            VALUES ($1, $2, $3, $4)
         RETURNING id, created_at AS "createdAt"`,
      [mapId, idNum, req.session.userId, grantCanWrite],
    );

    // Optionally admit the target to log in too (design Phase 2). The
    // positive-standing gate above already validated it. Insert an access_grants
    // row (source='share'); idempotent, and it never overrides an env/admin row.
    let loginGranted = false;
    if (alsoGrantLogin === true && config.restrictedMode) {
      const ins = await db.query(
        `INSERT INTO access_grants (kind, eve_id, source, note, added_by_user)
              VALUES ($1, $2, 'share', 'Added via map share', $3)
         ON CONFLICT (kind, eve_id) DO NOTHING`,
        [kind, idNum, req.session.userId],
      );
      loginGranted = (ins.rowCount ?? 0) > 0;
    }

    // Best-effort name resolve so the client can render immediately.
    const names = await resolveEntityNames([idNum]);
    res.status(201).json({
      id:        rows[0].id,
      kind,
      targetId:  idNum,
      name:      names.get(idNum)?.name ?? null,
      canWrite:  grantCanWrite,
      createdAt: rows[0].createdAt,
      loginGranted,
    });
  } catch (err) {
    // 23505 = unique violation (already shared with this target)
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Already shared with this target' });
      return;
    }
    throw err;
  }
});

// DELETE /api/maps/:mapId/shares/mine — a share RECIPIENT drops the map from
// their OWN list (leave the share) without deleting it for anyone else. This is
// the recipient counterpart to the owner-only revoke below: it deletes ONLY a
// map_shares row whose target_character_id is the caller's own EVE character, so
// it can never touch another character's grant or a corp/alliance-scoped grant
// (which belongs to the whole org — only an admin can revoke those via :shareId).
// The self-scoped WHERE makes this safe without a broader access check: with no
// matching personal grant it simply deletes nothing and 404s. Must be registered
// BEFORE the ':shareId' route so 'mine' isn't captured as a share UUID.
mapsRouter.delete('/:mapId/shares/mine', async (req, res) => {
  const { mapId } = req.params;
  if (!UUID_RE.test(mapId)) { res.status(404).json({ error: 'Map not found' }); return; }

  // Session-authed only — this is a personal-list action; external API keys
  // don't have a "my list" to leave. authUser resolves the session user id.
  const userId = req.session.userId;
  if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const { rows } = await db.query<{ callerChar: number | null }>(
    `SELECT character_id AS "callerChar" FROM users WHERE id = $1`,
    [userId],
  );
  const callerChar = rows[0]?.callerChar ?? null;
  if (callerChar === null) { res.status(400).json({ error: 'No character on account' }); return; }

  const { rowCount } = await db.query(
    `DELETE FROM map_shares WHERE map_id = $1 AND target_character_id = $2`,
    [mapId, callerChar],
  );
  if (!rowCount) { res.status(404).json({ error: 'No personal share to leave' }); return; }
  res.json({ ok: true });
});

// DELETE /api/maps/:mapId/shares/:shareId — revoke. Personal maps: owner only;
// corp/alliance maps: an admin / alliance-admin of the owning org.
mapsRouter.delete('/:mapId/shares/:shareId', async (req, res) => {
  const { mapId, shareId } = req.params;
  if (!UUID_RE.test(shareId)) { res.status(404).json({ error: 'Share not found' }); return; }
  const access = await requireShareAdmin(res, mapId, req);
  if (!access) return;

  const { rowCount } = await db.query(
    `DELETE FROM map_shares WHERE id = $1 AND map_id = $2`,
    [shareId, mapId],
  );
  if (!rowCount) { res.status(404).json({ error: 'Share not found' }); return; }
  res.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function touchMap(mapId: string) {
  await db.query(`UPDATE maps SET updated_at = NOW(), last_active_at = NOW() WHERE id = $1`, [mapId]);
}
