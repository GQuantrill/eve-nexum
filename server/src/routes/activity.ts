import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();
router.use(requireAuth);
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
const trackedSystems = new Set<number>();
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
        fetch(`${ESI}/universe/system_jumps/?datasource=tranquility`),
        fetch(`${ESI}/universe/system_kills/?datasource=tranquility`),
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
  trackedSystems.add(sysId);
}

async function recordSnapshot(): Promise<void> {
  const snap = await fetchEsi();
  if (!snap || trackedSystems.size === 0) return;

  const hour     = hourFloor();
  const hourDate = new Date(hour);

  // Single pass: refresh the in-memory ring buffer and collect arrays for the
  // bulk DB write.
  const sysIds:    number[] = [];
  const jumps:     number[] = [];
  const shipKills: number[] = [];
  const podKills:  number[] = [];
  const npcKills:  number[] = [];

  for (const sysId of trackedSystems) {
    const kll = snap.kills.get(sysId);
    const point: HourlyPoint = {
      hour,
      jumps:     snap.jumps.get(sysId) ?? 0,
      shipKills: kll?.ship_kills ?? 0,
      podKills:  kll?.pod_kills  ?? 0,
      npcKills:  kll?.npc_kills  ?? 0,
    };
    const history = systemHistory.get(sysId) ?? [];
    if (history.length > 0 && history[history.length - 1].hour === hour) {
      history[history.length - 1] = point;
    } else {
      history.push(point);
      if (history.length > MAX_HISTORY) history.shift();
    }
    systemHistory.set(sysId, history);

    sysIds.push(sysId);
    jumps.push(point.jumps);
    shipKills.push(point.shipKills);
    podKills.push(point.podKills);
    npcKills.push(point.npcKills);
  }

  // If we've already written this ESI snapshot to the DB, the rows wouldn't
  // change — skip the round-trip entirely.
  if (snap.fetchedAt === lastWrittenFetchedAt || sysIds.length === 0) return;

  // Bulk INSERT...ON CONFLICT in one round-trip via unnest() arrays. Previously
  // we did one INSERT per tracked system serially.
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
export async function initActivity(): Promise<void> {
  const { rows } = await db.query<{ eve_system_id: number }>(
    `SELECT DISTINCT eve_system_id FROM system_activity`,
  );
  for (const row of rows) trackedSystems.add(row.eve_system_id);
  await pruneOldRows();
  scheduleNextPoll();
}

function scheduleNextPoll() {
  const now  = Date.now();
  const next = Math.ceil(now / HOUR_MS) * HOUR_MS + 60_000;
  setTimeout(async () => {
    await recordSnapshot();
    scheduleNextPoll();
  }, next - now);
}

router.get('/:systemId(\\d+)', async (req, res) => {
  const eveSystemId = parseInt(req.params.systemId, 10);
  if (isNaN(eveSystemId)) { res.status(400).json({ error: 'invalid system id' }); return; }

  await ensureHistory(eveSystemId);
  await recordSnapshot();

  res.json(systemHistory.get(eveSystemId) ?? []);
});

export default router;
