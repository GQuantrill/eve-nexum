import { Router } from 'express';
import { esiFetch } from '../utils/esi.js';
import { db } from '../db.js';
import { config } from '../config.js';
import { liveKillCounts } from '../services/killBuffer.js';
import { getPvpForecast } from '../services/pvpHistory.js';
import { optionalAuth } from '../middleware/optionalAuth.js';

const router = Router();
router.use(optionalAuth);
const ESI         = 'https://esi.evetech.net/v1';
const HOUR_MS     = 60 * 60 * 1000;
const MAX_HISTORY = 24;
// Fallback cache lifetime when ESI sends no Expires header.
const ESI_CACHE_TTL = 5 * 60 * 1000;
// Never treat a snapshot as stale sooner than this, even if its Expires has
// already passed: CCP is sometimes late cutting the next one, and refetching on
// every request until it does would hammer ESI for the same bytes.
const MIN_CACHE_MS  = 60 * 1000;

export interface HourlyPoint {
  hour:      number;
  jumps:     number;
  shipKills: number;
  podKills:  number;
  npcKills:  number;
}

interface EsiJump { system_id: number; ship_jumps: number; }
interface EsiKill { system_id: number; ship_kills: number; pod_kills: number; npc_kills: number; }
interface EsiSnapshot {
  jumps:     Map<number, number>;
  kills:     Map<number, EsiKill>;
  fetchedAt: number;
  /** The hour this snapshot's counts belong to -- see snapshotHour. */
  hour:      number;
  /** When ESI says the next snapshot is due (its Expires header). */
  expiresAt: number;
}

const systemHistory  = new Map<number, HourlyPoint[]>();
// `trackedSystems` used to gate which systems recordSnapshot persisted.
// Now we persist every system in the ESI snapshot, so the in-memory
// `systemHistory` map alone is enough to know "do I have a buffer for
// this system this session" — set membership in `systemHistory` is the
// new tracker.
let   esiCache: EsiSnapshot | null = null;
let   fetching: Promise<EsiSnapshot | null> | null = null;
// Tracks the ESI snapshot timestamp that's already been written to the DB so
// we don't keep INSERT...ON CONFLICTing the same rows on every request.
let   lastWrittenFetchedAt = 0;

function hourFloor(ts = Date.now()): number {
  return ts - (ts % HOUR_MS);
}

// CCP rebuilds system_jumps / system_kills once an hour on its OWN cycle, not on
// the hour (lately about a quarter past): Last-Modified is when a snapshot was
// cut, it counts roughly the hour before that, and Expires is when the next one
// is due. Filing a snapshot under the hour it was FETCHED in labelled most hours
// wrong -- data for 08:15-09:15 fetched at 10:05 landed in the 10:00 bucket.
// Instead it goes in the hour holding most of its window: the one containing
// the window's midpoint, half an hour before the cut.
export function snapshotHour(lastModifiedMs: number): number {
  return hourFloor(lastModifiedMs - HOUR_MS / 2);
}

function headerMs(res: Response, name: string): number | null {
  const v = res.headers.get(name);
  const ms = v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

async function fetchEsi(): Promise<EsiSnapshot | null> {
  const now = Date.now();
  if (esiCache && now < Math.max(esiCache.expiresAt, esiCache.fetchedAt + MIN_CACHE_MS)) return esiCache;
  // Promise-cached so concurrent callers share one fetch (the old boolean
  // soft-lock raced — two callers could both see fetching=false).
  if (fetching) return fetching;

  fetching = (async () => {
    try {
      const [jRes, kRes] = await Promise.all([
        esiFetch(`${ESI}/universe/system_jumps/?datasource=tranquility`),
        esiFetch(`${ESI}/universe/system_kills/?datasource=tranquility`),
      ]);
      if (!jRes.ok || !kRes.ok) return esiCache;

      const [jumps, kills] = await Promise.all([
        jRes.json() as Promise<EsiJump[]>,
        kRes.json() as Promise<EsiKill[]>,
      ]);

      // Both endpoints are cut together; the kills one names the hour. Refresh
      // when the later of the two is due, so neither is read stale.
      const cutAt   = headerMs(kRes, 'last-modified') ?? headerMs(jRes, 'last-modified') ?? now;
      const expires = Math.max(headerMs(kRes, 'expires') ?? 0, headerMs(jRes, 'expires') ?? 0);
      esiCache = {
        jumps:     new Map(jumps.map((j) => [j.system_id, j.ship_jumps])),
        kills:     new Map(kills.map((k) => [k.system_id, k])),
        fetchedAt: now,
        hour:      snapshotHour(cutAt),
        expiresAt: expires > 0 ? expires : now + ESI_CACHE_TTL,
      };
      return esiCache;
    } catch {
      return esiCache;
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

async function loadFromDb(sysId: number): Promise<HourlyPoint[]> {
  const cutoff = new Date(hourFloor() - (MAX_HISTORY - 1) * HOUR_MS);
  const { rows } = await db.query<{
    hour: Date; jumps: string; ship_kills: string; pod_kills: string; npc_kills: string;
  }>(
    `SELECT hour, jumps, ship_kills, pod_kills, npc_kills
     FROM system_activity
     WHERE eve_system_id = $1 AND hour >= $2
     ORDER BY hour ASC`,
    [sysId, cutoff],
  );
  return rows.map((r) => ({
    hour:      r.hour.getTime(),
    jumps:     parseInt(r.jumps,      10),
    shipKills: parseInt(r.ship_kills, 10),
    podKills:  parseInt(r.pod_kills,  10),
    npcKills:  parseInt(r.npc_kills,  10),
  }));
}

async function ensureHistory(sysId: number): Promise<void> {
  if (systemHistory.has(sysId)) return;
  const history = await loadFromDb(sysId);
  systemHistory.set(sysId, history);
}

async function recordSnapshot(): Promise<void> {
  const snap = await fetchEsi();
  if (!snap) return;

  const hour     = snap.hour;
  const hourDate = new Date(hour);

  // Union of every system that appears in either ESI snapshot — these are
  // the systems with non-zero activity this hour. We persist a row for
  // each so the charts can render history for every k-space system, not
  // just the ones a Nexum user has opened.
  const systemsInSnap = new Set<number>();
  for (const id of snap.jumps.keys()) systemsInSnap.add(id);
  for (const id of snap.kills.keys()) systemsInSnap.add(id);
  if (systemsInSnap.size === 0) return;

  // Single pass: collect arrays for the bulk DB write + refresh the
  // in-memory ring buffer for any system we already have buffered (i.e.
  // someone has viewed it this session). Brand-new systems get loaded
  // from DB on first view via ensureHistory().
  const sysIds:    number[] = [];
  const jumps:     number[] = [];
  const shipKills: number[] = [];
  const podKills:  number[] = [];
  const npcKills:  number[] = [];

  for (const sysId of systemsInSnap) {
    const kll = snap.kills.get(sysId);
    const point: HourlyPoint = {
      hour,
      jumps:     snap.jumps.get(sysId) ?? 0,
      shipKills: kll?.ship_kills ?? 0,
      podKills:  kll?.pod_kills  ?? 0,
      npcKills:  kll?.npc_kills  ?? 0,
    };
    const history = systemHistory.get(sysId);
    if (history) {
      const last = history[history.length - 1];
      if (last && last.hour === hour) {
        history[history.length - 1] = point;
      } else if (last && last.hour > hour) {
        // An older snapshot than one we already hold -- nothing to add.
      } else {
        history.push(point);
        if (history.length > MAX_HISTORY) history.shift();
      }
    }

    sysIds.push(sysId);
    jumps.push(point.jumps);
    shipKills.push(point.shipKills);
    podKills.push(point.podKills);
    npcKills.push(point.npcKills);
  }

  // If we've already written this ESI snapshot to the DB, the rows wouldn't
  // change — skip the round-trip entirely.
  if (snap.fetchedAt === lastWrittenFetchedAt) return;

  // Bulk INSERT...ON CONFLICT in one round-trip via unnest() arrays. The
  // ON CONFLICT DO UPDATE here is what makes the boot-time fetch a safe
  // re-fetch — if the row for (system, hour) already exists from an
  // earlier process lifetime, we just overwrite it with the current
  // ESI-cached counts.
  await db.query(
    `INSERT INTO system_activity (eve_system_id, hour, jumps, ship_kills, pod_kills, npc_kills)
     SELECT * FROM unnest(
       $1::int[],
       ARRAY(SELECT $2::timestamptz FROM unnest($1::int[])),
       $3::int[], $4::int[], $5::int[], $6::int[]
     )
     ON CONFLICT (eve_system_id, hour) DO UPDATE SET
       jumps      = EXCLUDED.jumps,
       ship_kills = EXCLUDED.ship_kills,
       pod_kills  = EXCLUDED.pod_kills,
       npc_kills  = EXCLUDED.npc_kills`,
    [sysIds, hourDate, jumps, shipKills, podKills, npcKills],
  );
  lastWrittenFetchedAt = snap.fetchedAt;
}

async function pruneOldRows(): Promise<void> {
  const cutoff = new Date(hourFloor() - MAX_HISTORY * HOUR_MS);
  await db.query(`DELETE FROM system_activity WHERE hour < $1`, [cutoff]);
}

// Called from index.ts AFTER migrate() resolves — guarantees the
// `system_activity` table exists by the time we read from it. The previous
// fire-on-import pattern would swallow a "relation does not exist" error and
// then race writes against the migration on cold start.
//
// On boot we immediately call recordSnapshot() so the latest snapshot is
// captured (or refreshed via ON CONFLICT if a row already exists from a
// previous server lifetime). After that each poll is timed off the snapshot's
// own Expires, plus a short margin for ESI's cache to turn over, so a new
// snapshot is picked up within a minute or so of CCP publishing it. A fixed
// 61-minute interval drifted against CCP's cycle: the lag wandered between 0
// and 60 minutes and, a minute later every hour, it skipped a snapshot outright
// about every 60 hours.
const POLL_MARGIN_MS = 30 * 1000;
const POLL_MAX_MS    = 65 * 60 * 1000;

/** Delay until the next poll, given when ESI says the next snapshot is due. */
export function nextPollDelay(expiresAt: number | null, now = Date.now()): number {
  if (expiresAt == null) return ESI_CACHE_TTL; // no snapshot yet (ESI down): retry soon
  return Math.min(POLL_MAX_MS, Math.max(MIN_CACHE_MS, expiresAt - now + POLL_MARGIN_MS));
}

function schedulePoll(): void {
  const t = setTimeout(async () => {
    try { await recordSnapshot(); }
    catch (err) { console.error('[activity] poll failed:', err); }
    schedulePoll();
  }, nextPollDelay(esiCache?.expiresAt ?? null));
  t.unref?.();
}

export async function initActivity(): Promise<void> {
  await pruneOldRows();

  // Capture the latest ESI snapshot for *every* system right now. Failures
  // are non-fatal — we'll retry on the next poll.
  try { await recordSnapshot(); }
  catch (err) { console.error('[activity] boot snapshot failed:', err); }

  schedulePoll();
}

// Player kills in the system by UTC hour of day over the last 90 days, from the
// live kill feed: the system panel's "when is it busy" forecast. Kill data is
// public (zKillboard), so like the rest of this router it needs a login or a
// share link but no particular map's access.
router.get('/pvp/:systemId(\\d+)', async (req, res) => {
  const eveSystemId = Number(req.params.systemId);
  if (!Number.isInteger(eveSystemId) || eveSystemId <= 0 || eveSystemId > 2_147_483_647) {
    res.status(400).json({ error: 'invalid system id' });
    return;
  }
  res.json(await getPvpForecast(eveSystemId));
});

router.get('/:systemId(\\d+)', async (req, res) => {
  const eveSystemId = parseInt(req.params.systemId, 10);
  if (isNaN(eveSystemId)) { res.status(400).json({ error: 'invalid system id' }); return; }

  await ensureHistory(eveSystemId);
  // Persist a snapshot opportunistically, but don't block this per-system read
  // on a cluster-wide write — when a new ESI snapshot has landed, recordSnapshot
  // bulk-inserts every system. It's also driven by the background poller, so a
  // dropped one here is harmless. Fire-and-forget.
  void recordSnapshot().catch((err) => console.error('[activity] snapshot failed:', err));

  res.json(systemHistory.get(eveSystemId) ?? []);
});

// Player kills per system over the last 24 hours, for the count on each map
// node. Two sources, taking the higher per system rather than adding them
// (they count the same kills): our own live-feed history covers wormhole space
// and is up to the minute; CCP's hourly snapshots cover k-space for hours
// before our feed was running. Cluster-wide, so cached briefly and shared.
let kills24hCache: { at: number; value: Map<number, number> } | null = null;
async function kills24h(): Promise<Map<number, number>> {
  if (kills24hCache && Date.now() - kills24hCache.at < 60_000) return kills24hCache.value;
  const out = new Map<number, number>();
  try {
    const [ours, ccp] = await Promise.all([
      db.query<{ id: number; n: number }>(
        `SELECT eve_system_id AS id, SUM(kills)::int AS n FROM system_pvp_hours
          WHERE hour >= date_trunc('hour', NOW()) - interval '23 hours' GROUP BY 1`),
      db.query<{ id: number; n: number }>(
        `SELECT eve_system_id AS id, SUM(ship_kills + pod_kills)::int AS n FROM system_activity
          WHERE hour >= NOW() - interval '24 hours' GROUP BY 1`),
    ]);
    for (const r of [...ours.rows, ...ccp.rows]) if (r.n > (out.get(r.id) ?? 0)) out.set(r.id, r.n);
  } catch (err) {
    console.error('[activity] 24h kill counts failed:', err);
    return kills24hCache?.value ?? out;
  }
  kills24hCache = { at: Date.now(), value: out };
  return out;
}

// Snapshot of the current ESI kills cache, used to highlight "hot" systems on
// the map. One ESI call covers the whole cluster, already cached for 5 min by
// fetchEsi(), so this endpoint adds no extra upstream load.
router.get('/current-kills', async (_req, res) => {
  const snap = await fetchEsi();
  // Union of systems with kills and/or jumps so the client has every active
  // system's full metric set (ship/pod/npc kills + jumps) in one payload —
  // feeds the activity heatmaps. Jumps is a separate ESI map and covers
  // different systems (e.g. a quiet system with jumps but no kills).
  type Row = { systemId: number; shipKills: number; podKills: number; npcKills: number; jumps: number; kills24h: number };
  const bySys = new Map<number, Row>();
  if (snap) {
    const ids = new Set<number>([...snap.kills.keys(), ...snap.jumps.keys()]);
    for (const id of ids) {
      const k = snap.kills.get(id);
      bySys.set(id, {
        systemId:  id,
        shipKills: k?.ship_kills ?? 0,
        podKills:  k?.pod_kills ?? 0,
        npcKills:  k?.npc_kills ?? 0,
        jumps:     snap.jumps.get(id) ?? 0,
        kills24h:  0,
      });
    }
  }
  // The live R2Z2 feed OVERRIDES ESI's kill counts per system — it never sums,
  // so there's no double counting. This makes the heatmap near-real-time for any
  // system with recent kills and covers wormhole space (absent from ESI). ESI's
  // jumps are kept (the feed has no jumps metric). Systems the feed hasn't seen
  // recently fall back to ESI; when the feed is disabled this is a no-op and the
  // heatmap is pure ESI as before.
  for (const [systemId, c] of liveKillCounts(config.killFeed.heatWindowSeconds * 1_000)) {
    const row = bySys.get(systemId) ?? { systemId, shipKills: 0, podKills: 0, npcKills: 0, jumps: 0, kills24h: 0 };
    row.shipKills = c.shipKills;
    row.podKills  = c.podKills;
    row.npcKills  = c.npcKills;
    bySys.set(systemId, row);
  }
  for (const [systemId, n] of await kills24h()) {
    const row = bySys.get(systemId) ?? { systemId, shipKills: 0, podKills: 0, npcKills: 0, jumps: 0, kills24h: 0 };
    row.kills24h = n;
    bySys.set(systemId, row);
  }
  // Never less than this hour's own count.
  for (const row of bySys.values()) row.kills24h = Math.max(row.kills24h, row.shipKills + row.podKills);
  res.json([...bySys.values()]);
});

export default router;
