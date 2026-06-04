import { Router } from 'express';
import { esiFetch } from '../utils/esi.js';
import { db } from '../db.js';
import { optionalAuth } from '../middleware/optionalAuth.js';

const router = Router();
router.use(optionalAuth);
const ESI         = 'https://esi.evetech.net/v1';
const HOUR_MS     = 60 * 60 * 1000;
const MAX_HISTORY = 24;
const ESI_CACHE_TTL = 5 * 60 * 1000;

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

async function fetchEsi(): Promise<EsiSnapshot | null> {
  const now = Date.now();
  if (esiCache && now - esiCache.fetchedAt < ESI_CACHE_TTL) return esiCache;
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

      esiCache = {
        jumps:     new Map(jumps.map((j) => [j.system_id, j.ship_jumps])),
        kills:     new Map(kills.map((k) => [k.system_id, k])),
        fetchedAt: now,
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

  const hour     = hourFloor();
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
      if (history.length > 0 && history[history.length - 1].hour === hour) {
        history[history.length - 1] = point;
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
// On boot we immediately call recordSnapshot() so the current hour's data
// is captured (or refreshed via ON CONFLICT if a row already exists from
// a previous server lifetime). Then a 61-minute interval keeps us
// comfortably past CCP's 60-minute cache TTL on every subsequent poll,
// so we never refetch the same hourly aggregate twice in a row.
const POLL_MS = 61 * 60 * 1000;

export async function initActivity(): Promise<void> {
  await pruneOldRows();

  // Capture the latest ESI snapshot for *every* system right now. Failures
  // are non-fatal — we'll retry on the next poll.
  try { await recordSnapshot(); }
  catch (err) { console.error('[activity] boot snapshot failed:', err); }

  setInterval(() => {
    recordSnapshot().catch((err) => console.error('[activity] poll failed:', err));
  }, POLL_MS);
}

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

// Snapshot of the current ESI kills cache, used to highlight "hot" systems on
// the map. One ESI call covers the whole cluster, already cached for 5 min by
// fetchEsi(), so this endpoint adds no extra upstream load.
router.get('/current-kills', async (_req, res) => {
  const snap = await fetchEsi();
  if (!snap) { res.json([]); return; }
  // Union of systems with kills and/or jumps so the client has every active
  // system's full metric set (ship/pod/npc kills + jumps) in one payload —
  // feeds the activity heatmaps. Jumps is a separate ESI map and covers
  // different systems (e.g. a quiet system with jumps but no kills).
  const ids = new Set<number>([...snap.kills.keys(), ...snap.jumps.keys()]);
  const arr = Array.from(ids, (id) => {
    const k = snap.kills.get(id);
    return {
      systemId:  id,
      shipKills: k?.ship_kills ?? 0,
      podKills:  k?.pod_kills ?? 0,
      npcKills:  k?.npc_kills ?? 0,
      jumps:     snap.jumps.get(id) ?? 0,
    };
  });
  res.json(arr);
});

export default router;
