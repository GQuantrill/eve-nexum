import { Router } from 'express';
import { esiFetch } from '../utils/esi.js';
import type { Request, Response } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authUser } from '../middleware/authContext.js';
import { config } from '../config.js';
import { decryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';
import { resolveOwnerId } from '../utils/owner.js';
import { resolveEntityNames } from '../services/entityNames.js';
import { audit } from '../services/audit.js';
import { publishToMap } from '../services/mapEvents.js';
import { streamMapEvents } from '../services/mapStream.js';
import { listVisibleMaps, loadFullMap, loadSystemSignatures, loadSystemAnomalies, loadSystemStructures } from '../services/mapRead.js';
import {
  createSignature, updateSignature, deleteSignature,
  createAnomaly, updateAnomaly, deleteAnomaly,
  createStructure, updateStructure, deleteStructure,
} from '../services/mapWrite.js';
import { reportPresence } from '../services/presence.js';
import { notifyDiscord, webhookFor, k162Embed, connectionEmbed } from '../services/discord.js';

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
//   - owner        : their personal map (or a corp map they happened to create)
//   - corp_member  : visible via corp membership; role-gated for writes
//   - shared       : explicit map_shares grant (character or corp) — full edit,
//                    no role check, but lock + owner-only ops still apply
export type AccessKind = 'owner' | 'corp_member' | 'shared';
export interface MapMeta {
  userId:     number;
  corpId:     number | null;
  locked:     boolean;
  accessKind: AccessKind;
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
  const auth       = authUser(req);
  const userId     = auth.userId;
  const userCorpId = auth.corpId;

  // Pull map + caller's EVE character id in one round-trip; the latter is
  // needed to match against map_shares.target_character_id.
  const { rows } = await db.query<{
    userId:     number;
    corpId:     number | null;
    locked:     boolean;
    callerChar: number;
    mapOwner:    number | null;
    callerOwner: number | null;
  }>(
    `SELECT m.user_id AS "userId",
            m.corp_id AS "corpId",
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

  // Owner = this account. A map belongs to the account that owns it (any of
  // the account's characters), with a defensive fall back to the creating
  // character so you can never lose access to a map you made even if owner_id
  // is somehow unset.
  if (m.userId === userId || (m.mapOwner != null && m.callerOwner != null && m.mapOwner === m.callerOwner)) {
    return { userId: m.userId, corpId: m.corpId, locked: m.locked, accessKind: 'owner' };
  }

  const isCorpMap = config.corpMode
    && m.corpId !== null
    && config.corpIds.includes(m.corpId)
    && (config.corpMapShared || m.corpId === userCorpId);
  if (isCorpMap) {
    return { userId: m.userId, corpId: m.corpId, locked: m.locked, accessKind: 'corp_member' };
  }

  // Personal map shared with this character or their corp? Personal-map only —
  // corp maps don't accept individual grants. Corp grants resolve against the
  // caller's *current* corp_id; switching corps moves access with them.
  if (m.corpId === null) {
    const { rowCount } = await db.query(
      `SELECT 1 FROM map_shares
         WHERE map_id = $1
           AND ( target_character_id = $2
              OR ($3::int IS NOT NULL AND target_corp_id = $3) )
         LIMIT 1`,
      [mapId, m.callerChar, userCorpId],
    );
    if (rowCount && rowCount > 0) {
      return { userId: m.userId, corpId: m.corpId, locked: m.locked, accessKind: 'shared' };
    }
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

  // Owners and explicit-share recipients always get write access. A share
  // grant is a deliberate invitation by the owner — honouring it shouldn't
  // depend on the recipient's general role. Corp-map writes still go through
  // the role check so readonly corp members can't silently edit.
  if (access.accessKind === 'corp_member' && role === 'readonly') {
    res.status(403).json({ error: 'Write access required' }); return null;
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
  if (access.locked && authUser(req).role !== 'admin') {
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
interface PendingK162 { timer: ReturnType<typeof setTimeout>; corpId: number | null; actor: string | null; }
const pendingK162 = new Map<string, PendingK162>();

export function dispatchK162(meta: MapMeta, sigId: string, systemId: string, actor: string | null): void {
  if (!webhookFor(meta.corpId)) {
    discordLog.info(`K162 detected (system ${systemId}) but not sending — no webhook for corpId=${meta.corpId ?? 'null (personal map; webhooks are corp-maps only)'}`);
    return;
  }
  if (pendingK162.has(sigId)) {
    discordLog.info(`K162 (sig ${sigId}) already pending — keeping the existing ${K162_DEFER_MS / 1000}s window`);
    return;
  }
  discordLog.info(`K162 on corp map (corpId=${meta.corpId}, sig ${sigId}) — deferring ${K162_DEFER_MS / 1000}s to catch a leads-to`);
  const timer = setTimeout(() => {
    pendingK162.delete(sigId);
    void fireK162(meta.corpId, sigId, actor);
  }, K162_DEFER_MS);
  pendingK162.set(sigId, { timer, corpId: meta.corpId, actor });
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
  void fireK162(p.corpId, sigId, p.actor);
}

// Re-read the signature now (after the defer window) and send if it's still a
// K162, including the leads-to if one was set in the meantime.
async function fireK162(corpId: number | null, sigId: string, actor: string | null): Promise<void> {
  try {
    const { rows } = await db.query<{
      whType: string | null; leadsTo: string | null; system: string; systemClass: string;
      region: string | null; mapName: string; mapEnabled: boolean; allRegions: boolean; regions: string[];
    }>(
      `SELECT sg.wh_type AS "whType", sg.wh_leads_to AS "leadsTo",
              s.name AS "system", s.system_class AS "systemClass", s.region_name AS "region",
              m.name AS "mapName", m.discord_notify AS "mapEnabled",
              COALESCE(cds.all_regions, TRUE)        AS "allRegions",
              COALESCE(cds.regions, '{}'::text[])    AS "regions"
         FROM map_signatures sg
         JOIN map_systems s ON s.id = sg.system_id
         JOIN maps m ON m.id = s.map_id
         LEFT JOIN corp_discord_settings cds ON cds.corp_id = $2
        WHERE sg.id = $1`,
      [sigId, corpId],
    );
    const r = rows[0];
    if (!r) { discordLog.info(`K162 (sig ${sigId}) removed before send — skipping`); return; }
    if ((r.whType ?? '').toUpperCase() !== 'K162') {
      discordLog.info(`K162 (sig ${sigId}) changed to "${r.whType ?? ''}" before send — skipping`);
      return;
    }
    if (!r.mapEnabled) {
      discordLog.info(`K162 (sig ${sigId}) suppressed — map "${r.mapName}" is excluded from Discord`);
      return;
    }
    if (!regionAllowed(r.allRegions, r.regions, [r.region])) {
      discordLog.info(`K162 (sig ${sigId}) suppressed — region "${r.region ?? 'unknown'}" not in the corp filter`);
      return;
    }
    notifyDiscord(corpId, k162Embed({ system: r.system, systemClass: r.systemClass, leadsTo: r.leadsTo, mapName: r.mapName, actor }));
  } catch (e) {
    discordLog.warn(`K162 deferred dispatch failed: ${(e as Error).message}`);
  }
}

function dispatchNewConnection(
  meta: MapMeta, mapId: string, sourceId: string, targetId: string,
  whType: string | null, size: string | null, actor: string | null,
): void {
  if (!webhookFor(meta.corpId)) {
    discordLog.info(`new connection but not sending — no webhook for corpId=${meta.corpId ?? 'null (personal map; webhooks are corp-maps only)'}`);
    return;
  }
  discordLog.info(`new connection on corp map (corpId=${meta.corpId}) — building notification`);
  db.query<{
    a: string; b: string; regionA: string | null; regionB: string | null;
    mapName: string; mapEnabled: boolean; allRegions: boolean; regions: string[];
  }>(
    `SELECT a.name AS a, b.name AS b, a.region_name AS "regionA", b.region_name AS "regionB",
            m.name AS "mapName", m.discord_notify AS "mapEnabled",
            COALESCE(cds.all_regions, TRUE)     AS "allRegions",
            COALESCE(cds.regions, '{}'::text[]) AS "regions"
       FROM maps m
       JOIN map_systems a ON a.id = $2
       JOIN map_systems b ON b.id = $3
       LEFT JOIN corp_discord_settings cds ON cds.corp_id = $4
      WHERE m.id = $1`,
    [mapId, sourceId, targetId, meta.corpId],
  ).then(({ rows }) => {
    const r = rows[0];
    if (!r) { discordLog.warn(`connection dispatch: endpoints not found`); return; }
    if (!r.mapEnabled) {
      discordLog.info(`new connection suppressed — map "${r.mapName}" is excluded from Discord`);
      return;
    }
    if (!regionAllowed(r.allRegions, r.regions, [r.regionA, r.regionB])) {
      discordLog.info(`new connection suppressed — neither region (${r.regionA ?? '?'} / ${r.regionB ?? '?'}) in the corp filter`);
      return;
    }
    notifyDiscord(meta.corpId, connectionEmbed({ a: r.a, b: r.b, whType, size, mapName: r.mapName, actor }));
  }).catch((e) => discordLog.warn(`connection dispatch query failed: ${(e as Error).message}`));
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

// ── Maps ──────────────────────────────────────────────────────────────────────

const MAX_MAP_NAME_LEN  = 200;
const MAX_IMPORT_SYSTEMS     = 500;
const MAX_IMPORT_CONNECTIONS = 2000;

// GET /api/maps
mapsRouter.get('/', async (req, res) => {
  const userId     = req.session.userId!;
  const userCorpId = req.session.userCorpId ?? null;
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

  // Visibility query (personal + corp + shared) lives in the shared map-read
  // module so the external /api/v1 list returns the identical set.
  const rows = await listVisibleMaps({ userId, ownerId, userCorpId, callerChar });

  // Count corp maps for the user's own corp (the per-corp limit applies to
  // each corp independently — Corp A's slots are separate from Corp B's).
  const corpMapCount = config.corpMode && userCorpId
    ? (await db.query(`SELECT 1 FROM maps WHERE corp_id = $1`, [userCorpId])).rowCount ?? 0
    : 0;

  res.json({ maps: rows, maxMaps: config.maxUserMaps, maxCorpMaps: config.maxCorpMaps, corpMapCount });
});

// POST /api/maps
mapsRouter.post('/', async (req, res) => {
  const isCorpMap = config.corpMode && req.body.isCorpMap === true;
  const role      = req.session.role ?? 'readonly';

  // Personal map creation is open to every role — they're scoped to the
  // individual user, so role gating only matters for shared (corp) maps.
  // Corp map creation still requires 'full' or 'admin'.
  if (isCorpMap) {
    if (role !== 'full' && role !== 'admin') {
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
      `SELECT 1 FROM maps WHERE owner_id = $1 AND corp_id IS NULL`,
      [ownerId],
    );
    if ((rowCount ?? 0) >= config.maxUserMaps) {
      res.status(403).json({ error: 'Maximum maps reached' });
      return;
    }
  }

  const name    = String(req.body.name ?? 'New Map').slice(0, MAX_MAP_NAME_LEN);
  const corpId  = isCorpMap ? (req.session.userCorpId ?? null) : null;
  const ownerId = await resolveOwnerId(req);

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, owner_id, name, corp_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.session.userId, ownerId, name, corpId],
  );
  res.status(201).json({ id: rows[0].id });
});

// POST /api/maps/from-region — create a new map pre-populated with an entire
// K-space region: every system positioned by its EVE coordinates (Dotlan-style
// projection of x/z) plus all intra-region stargate links. Blank-map creation
// stays on POST /api/maps; this is only the seeded path. See
// region_map_feature.md.
mapsRouter.post('/from-region', async (req, res) => {
  const body     = req.body as { regionId?: unknown; name?: unknown; isCorpMap?: unknown };
  const regionId = Number(body.regionId);
  if (!Number.isInteger(regionId)) { res.status(400).json({ error: 'regionId is required' }); return; }

  const isCorpMap = config.corpMode && body.isCorpMap === true;
  const role      = req.session.role ?? 'readonly';

  // Quota + role — mirrors POST /api/maps and /import.
  if (isCorpMap) {
    if (role !== 'full' && role !== 'admin') {
      res.status(403).json({ error: 'Corp map creation requires full-edit or admin role' }); return;
    }
    if (!req.session.userCorpId) {
      res.status(403).json({ error: 'Cannot create corp map: user has no corp affiliation' }); return;
    }
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE corp_id = $1`, [req.session.userCorpId]);
    if ((rowCount ?? 0) >= config.maxCorpMaps) { res.status(403).json({ error: 'Maximum corp maps reached' }); return; }
  } else {
    const oid = await resolveOwnerId(req);
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE owner_id = $1 AND corp_id IS NULL`, [oid]);
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
    const mapRes = await client.query<{ id: string }>(
      `INSERT INTO maps (user_id, owner_id, name, corp_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.session.userId, ownerId, mapName, isCorpMap ? (req.session.userCorpId ?? null) : null],
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
      connVals.push(crypto.randomUUID(), mapId, src, tgt, 'standard', 'large');
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
  const isCorpImport = config.corpMode && (req.body as Record<string, unknown>).isCorpMap === true;
  const role         = req.session.role ?? 'readonly';

  // Quota check against the matching tier — importing a corp map counts
  // against MAX_CORP_MAPS (for the user's corp), importing a personal map
  // counts against MAX_USER_MAPS. Previously this always checked the
  // personal quota, so corp imports skipped MAX_CORP_MAPS entirely.
  // Personal imports are open to every role; corp imports need full/admin.
  if (isCorpImport) {
    if (role !== 'full' && role !== 'admin') {
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
      `SELECT 1 FROM maps WHERE owner_id = $1 AND corp_id IS NULL`,
      [oid],
    );
    if ((rowCount ?? 0) >= config.maxUserMaps) {
      res.status(403).json({ error: 'Maximum maps reached' });
      return;
    }
  }

  const { name, systems = [], connections = [] } = req.body as {
    name?: string;
    systems?: Array<Record<string, unknown>>;
    connections?: Array<Record<string, unknown>>;
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
    const mapRes = await client.query<{ id: string }>(
      `INSERT INTO maps (user_id, owner_id, name, corp_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.session.userId, ownerId, importName, isCorpImport ? (req.session.userCorpId ?? null) : null],
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
    const [destSysRes, destConnRes, srcSysRes, srcConnRes] = await Promise.all([
      client.query<{ id: string; eveSystemId: number | null; name: string; notes: string; x: number; y: number }>(
        `SELECT id, eve_system_id AS "eveSystemId", name, notes, position_x AS x, position_y AS y
           FROM map_systems WHERE map_id = $1`, [destId]),
      client.query<{ sourceId: string; targetId: string }>(
        `SELECT source_id AS "sourceId", target_id AS "targetId" FROM map_connections WHERE map_id = $1`, [destId]),
      client.query<{
        id: string; eveSystemId: number | null; name: string; systemClass: string; effect: string;
        statics: string[]; regionName: string | null; npcType: string | null; x: number; y: number;
        status: string; notes: string;
      }>(
        `SELECT id, eve_system_id AS "eveSystemId", name, system_class AS "systemClass", effect, statics,
                region_name AS "regionName", npc_type AS "npcType", position_x AS x, position_y AS y, status, notes
           FROM map_systems WHERE map_id = $1`, [sourceId]),
      client.query<{
        sourceId: string; targetId: string; sourceHandle: string | null; targetHandle: string | null;
        connectionType: string; massStatus: string | null; timeStatus: string | null; size: string; whType: string | null;
      }>(
        `SELECT source_id AS "sourceId", target_id AS "targetId", source_handle AS "sourceHandle",
                target_handle AS "targetHandle", connection_type AS "connectionType",
                mass_status AS "massStatus", time_status AS "timeStatus", size, wh_type AS "whType"
           FROM map_connections WHERE map_id = $1`, [sourceId]),
    ]);

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
      const [srcSigs, destSigs] = await Promise.all([
        client.query<{ systemId: string; sigId: string; sigType: string; name: string; notes: string; whType: string; whLeadsTo: string }>(
          `SELECT system_id AS "systemId", sig_id AS "sigId", sig_type AS "sigType", name, notes,
                  wh_type AS "whType", wh_leads_to AS "whLeadsTo"
             FROM map_signatures WHERE system_id = ANY($1::uuid[])`, [srcSysIds]),
        client.query<{ id: string; systemId: string; sigId: string }>(
          `SELECT id, system_id AS "systemId", sig_id AS "sigId"
             FROM map_signatures WHERE system_id = ANY($1::uuid[])`, [destSysIds]),
      ]);
      const destSigMap = new Map<string, string>(); // `${destSysId}|${sigIdLower}` → dest sig id
      for (const ds of destSigs.rows) {
        const k = ds.sigId.trim().toLowerCase();
        if (k) destSigMap.set(`${ds.systemId}|${k}`, ds.id);
      }
      const sigPh: string[] = []; const sigVals: unknown[] = [];
      for (const sg of srcSigs.rows) {
        const destSysId = idMap.get(sg.systemId);
        if (!destSysId) continue;
        const k = sg.sigId.trim().toLowerCase();
        const existing = k ? destSigMap.get(`${destSysId}|${k}`) : undefined;
        if (existing) {
          await client.query(
            `UPDATE map_signatures SET sig_type=$1, name=$2, notes=$3, wh_type=$4, wh_leads_to=$5, updated_at=NOW() WHERE id=$6`,
            [sg.sigType, sg.name, sg.notes, sg.whType, sg.whLeadsTo, existing],
          );
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
      const [srcStructs, destStructs] = await Promise.all([
        client.query<{ systemId: string; name: string; structureType: string; ownerCorp: string; eveId: string | null; notes: string; ownerCorpId: number | null }>(
          `SELECT system_id AS "systemId", name, structure_type AS "structureType", owner_corp AS "ownerCorp",
                  eve_id AS "eveId", notes, owner_corp_id AS "ownerCorpId"
             FROM map_structures WHERE system_id = ANY($1::uuid[])`, [srcSysIds]),
        client.query<{ id: string; systemId: string; name: string; eveId: string | null }>(
          `SELECT id, system_id AS "systemId", name, eve_id AS "eveId"
             FROM map_structures WHERE system_id = ANY($1::uuid[])`, [destSysIds]),
      ]);
      const byEve  = new Map<string, string>(); // `${destSysId}|${eveId}`     → id
      const byName = new Map<string, string>(); // `${destSysId}|${nameLower}` → id
      for (const d of destStructs.rows) {
        if (d.eveId != null) byEve.set(`${d.systemId}|${d.eveId}`, d.id);
        const nk = (d.name ?? '').trim().toLowerCase();
        if (nk) byName.set(`${d.systemId}|${nk}`, d.id);
      }
      const stPh: string[] = []; const stVals: unknown[] = [];
      for (const st of srcStructs.rows) {
        const destSysId = idMap.get(st.systemId);
        if (!destSysId) continue;
        let existing = st.eveId != null ? byEve.get(`${destSysId}|${st.eveId}`) : undefined;
        if (!existing) {
          const nk = (st.name ?? '').trim().toLowerCase();
          if (nk) existing = byName.get(`${destSysId}|${nk}`);
        }
        if (existing) {
          await client.query(
            `UPDATE map_structures SET name=$1, structure_type=$2, owner_corp=$3, owner_corp_id=$4, eve_id=$5, notes=$6, updated_at=NOW() WHERE id=$7`,
            [st.name, st.structureType, st.ownerCorp, st.ownerCorpId, st.eveId, st.notes, existing],
          );
          updatedStructures++;
        } else {
          const base = stVals.length;
          stPh.push(`(${Array.from({ length: 8 }, (_, i) => `$${base + i + 1}`).join(',')})`);
          stVals.push(destSysId, st.name, st.structureType, st.ownerCorp, st.eveId, st.notes, req.session.userId, st.ownerCorpId);
          addedStructures++;
        }
      }
      if (stPh.length > 0) {
        await client.query(
          `INSERT INTO map_structures (system_id, name, structure_type, owner_corp, eve_id, notes, created_by_user_id, owner_corp_id)
           VALUES ${stPh.join(',')}`, stVals,
        );
      }
    }

    // ── Apply queued system-note merges ──────────────────────────────────
    for (const nm of noteMerges) {
      await client.query(`UPDATE map_systems SET notes = $1 WHERE id = $2`, [nm.notes, nm.destSysId]);
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
  res.json(full);
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
  const { name, locked, allowAsMergeSource, allowAsMergeDestination } = req.body as {
    name?: string; locked?: boolean; allowAsMergeSource?: boolean; allowAsMergeDestination?: boolean;
  };

  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];

  // Merge opt-in flags are corp-map sharing policy: only meaningful on a corp
  // map, and gated above ordinary edit access to full/admin.
  if (allowAsMergeSource !== undefined || allowAsMergeDestination !== undefined) {
    if (access.corpId === null) {
      res.status(400).json({ error: 'Only corp maps can be flagged as a merge source/destination' }); return;
    }
    const role = req.session.role ?? 'readonly';
    if (role !== 'full' && role !== 'admin') {
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
    const trimmed = String(name).slice(0, MAX_MAP_NAME_LEN);
    if (!trimmed) { res.status(400).json({ error: 'name cannot be empty' }); return; }
    sets.push(`name = $${vals.length + 1}`); vals.push(trimmed);
  }
  if (locked !== undefined) {
    if (req.session.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return; }
    sets.push(`locked = $${vals.length + 1}`); vals.push(locked);
  }

  if (sets.length === 1) { res.status(400).json({ error: 'Nothing to update' }); return; }

  await db.query(`UPDATE maps SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`, [...vals, mapId]);
  // Live-sync rename / lock to other viewers (the only map-level fields the
  // canvas shows). Merge-source flags are sidebar-only, so not pushed.
  if (name !== undefined || locked !== undefined) {
    publishToMap(mapId, {
      type: 'map.meta',
      actor: req.get('x-client-id') ?? null,
      ...(name !== undefined ? { name: String(name).slice(0, MAX_MAP_NAME_LEN) } : {}),
      ...(locked !== undefined ? { locked } : {}),
    });
  }
  res.json({ ok: true });
});

// DELETE /api/maps/:mapId — owner can delete personal maps; admin can delete any
mapsRouter.delete('/:mapId', async (req, res) => {
  const { mapId } = req.params;
  const access = await getMapAccess(mapId, req);
  if (!access) { res.status(404).json({ error: 'Map not found' }); return; }

  const isOwner  = access.userId === req.session.userId;
  const isCorpMap = access.corpId !== null;

  if (isCorpMap && req.session.role !== 'admin') {
    res.status(403).json({ error: 'Only admins can delete corp maps' }); return;
  }
  if (!isOwner && req.session.role !== 'admin') {
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
  const { id, sourceId, targetId, sourceHandle, targetHandle, connectionType, massStatus, timeStatus, size } = req.body;

  const access = await requireMapWrite(res, mapId, req);
  if (!access) return;

  let inserted = 0;
  try {
    const ins = await db.query(
      `INSERT INTO map_connections
         (id, map_id, source_id, target_id, source_handle, target_handle,
          connection_type, mass_status, time_status, size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [id, mapId, sourceId, targetId, sourceHandle ?? null, targetHandle ?? null,
       connectionType ?? 'standard', massStatus ?? null, timeStatus ?? null, size ?? 'large'],
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
    `SELECT id, source_id AS "sourceId", target_id AS "targetId", source_handle AS "sourceHandle",
            target_handle AS "targetHandle", connection_type AS "connectionType", mass_status AS "massStatus",
            time_status AS "timeStatus", size, wh_type AS "type", COALESCE(mass_used, 0)::float8 AS "massUsed",
            eol_at AS "eolAt", created_at AS "createdAt"
       FROM map_connections WHERE id = $1 AND map_id = $2`,
    [id, mapId],
  ).then(({ rows }) => {
    if (rows[0]) publishToMap(mapId, { type: 'connection.add', actor: req.get('x-client-id') ?? null, connection: rows[0] });
  }).catch(console.error);
  // Only notify on a genuinely new wormhole connection — not a duplicate-id
  // retry, and not an in-game stargate (jumpgate) link.
  if (inserted > 0 && (connectionType ?? 'standard') !== 'jumpgate') {
    dispatchNewConnection(access, mapId, sourceId, targetId, null, size ?? 'large', req.session.characterName ?? null);
  }
  res.status(201).json({ ok: true });
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
    eolAt: 'eol_at',
  };

  const updates = req.body as Record<string, unknown>;
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
    `SELECT s.system_id AS "systemId", s.sig_type AS "sigType", s.name, s.wh_type AS "whType"
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
  const isCorpMap = config.corpMode
    && access.corpId !== null
    && config.corpIds.includes(access.corpId);

  if (isCorpMap) {
    if (role !== 'admin') {
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

// GET /api/maps/:mapId/shares — owner-only list of current grants.
// Returns the EVE id, target kind, when it was granted, and a resolved
// human-readable name so the picker UI doesn't have to fan out to ESI.
mapsRouter.get('/:mapId/shares', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireMapOwner(res, mapId, req);
  if (!access) return;
  if (access.corpId !== null) {
    res.status(400).json({ error: 'Corp maps cannot have per-character shares' });
    return;
  }

  const { rows } = await db.query<{
    id: string;
    targetCharacterId: number | null;
    targetCorpId:      number | null;
    createdAt:         string;
  }>(
    `SELECT id,
            target_character_id AS "targetCharacterId",
            target_corp_id      AS "targetCorpId",
            created_at          AS "createdAt"
       FROM map_shares
      WHERE map_id = $1
      ORDER BY created_at`,
    [mapId],
  );

  // Resolve all referenced EVE ids in a single batched call.
  const ids = rows.flatMap((r) => [r.targetCharacterId, r.targetCorpId])
    .filter((x): x is number => x != null);
  const names = await resolveEntityNames(ids);

  res.json({
    shares: rows.map((r) => ({
      id:                  r.id,
      kind:                r.targetCharacterId != null ? 'character' : 'corp',
      targetId:            (r.targetCharacterId ?? r.targetCorpId)!,
      name:                names.get((r.targetCharacterId ?? r.targetCorpId)!)?.name ?? null,
      createdAt:           r.createdAt,
    })),
  });
});

// POST /api/maps/:mapId/shares — owner-only grant create.
// Body: { kind: 'character' | 'corp', targetId: number }
// Returns the resolved name + canonical row so the client can show it
// immediately without re-fetching the whole list.
mapsRouter.post('/:mapId/shares', async (req, res) => {
  const { mapId } = req.params;
  const access = await requireMapOwner(res, mapId, req);
  if (!access) return;
  if (access.corpId !== null) {
    res.status(400).json({ error: 'Corp maps cannot have per-character shares' });
    return;
  }

  const { kind, targetId } = req.body as { kind?: unknown; targetId?: unknown };
  if (kind !== 'character' && kind !== 'corp') {
    res.status(400).json({ error: 'kind must be "character" or "corp"' });
    return;
  }
  const idNum = Number(targetId);
  if (!Number.isInteger(idNum) || idNum <= 0 || idNum > 2_147_483_647) {
    res.status(400).json({ error: 'targetId must be a positive integer' });
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

  try {
    const { rows } = await db.query<{ id: string; createdAt: string }>(
      kind === 'character'
        ? `INSERT INTO map_shares (map_id, target_character_id, granted_by_user_id)
                VALUES ($1, $2, $3)
             RETURNING id, created_at AS "createdAt"`
        : `INSERT INTO map_shares (map_id, target_corp_id, granted_by_user_id)
                VALUES ($1, $2, $3)
             RETURNING id, created_at AS "createdAt"`,
      [mapId, idNum, req.session.userId],
    );

    // Best-effort name resolve so the client can render immediately.
    const names = await resolveEntityNames([idNum]);
    res.status(201).json({
      id:        rows[0].id,
      kind,
      targetId:  idNum,
      name:      names.get(idNum)?.name ?? null,
      createdAt: rows[0].createdAt,
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

// DELETE /api/maps/:mapId/shares/:shareId — owner-only revoke.
mapsRouter.delete('/:mapId/shares/:shareId', async (req, res) => {
  const { mapId, shareId } = req.params;
  if (!UUID_RE.test(shareId)) { res.status(404).json({ error: 'Share not found' }); return; }
  const access = await requireMapOwner(res, mapId, req);
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
