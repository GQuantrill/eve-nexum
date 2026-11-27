// Where pilots have been seen.
//
// A local list pasted and pinned to a system records every pilot in it there;
// the desktop app's intel feed records a watched pilot named in a line beside
// a system. Each row belongs to a map and is shown to everyone who can see that
// map, so a corp's pastes build one shared picture of who has been where. Rows
// are kept SIGHTING_DAYS, then swept.
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('pilotSightings');

export const SIGHTING_DAYS = 30;
/** The same pilot pasted into the same system again within this long is one
 *  sighting, not several: re-pasting local every minute shouldn't inflate it. */
const REPEAT_MINUTES = 10;
/** Most rows one list request returns. */
export const MAX_LIST_ROWS = 2_000;

export type SightingSource = 'local' | 'intel';

export interface SightedPilot {
  id: number;
  name: string;
  corpId?: number | null;
  allianceId?: number | null;
}

export async function recordSightings(p: {
  mapId: string;
  eveSystemId: number;
  pilots: SightedPilot[];
  source: SightingSource;
  seenBy: number | null;
}): Promise<number> {
  const byId = new Map<number, SightedPilot>();
  for (const x of p.pilots) if (Number.isInteger(x.id) && x.id > 0 && !byId.has(x.id)) byId.set(x.id, x);
  const pilots = [...byId.values()];
  if (pilots.length === 0) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO pilot_sightings
            (map_id, eve_system_id, character_id, character_name, corp_id, alliance_id, source, seen_by)
     SELECT $1, $2, p.id, p.name, p.corp, p.alliance, $3, $4
       FROM unnest($5::int[], $6::text[], $7::int[], $8::int[]) AS p(id, name, corp, alliance)
      WHERE NOT EXISTS (
        SELECT 1 FROM pilot_sightings s
         WHERE s.character_id = p.id AND s.map_id = $1 AND s.eve_system_id = $2
           AND s.seen_at > NOW() - make_interval(mins => $9))`,
    [
      p.mapId, p.eveSystemId, p.source, p.seenBy,
      pilots.map((x) => x.id),
      pilots.map((x) => x.name),
      pilots.map((x) => x.corpId ?? null),
      pilots.map((x) => x.allianceId ?? null),
      REPEAT_MINUTES,
    ],
  );
  return rowCount ?? 0;
}

export interface Sighting {
  characterId: number;
  name: string;
  corpId: number | null;
  allianceId: number | null;
  eveSystemId: number;
  systemName: string | null;
  mapId: string;
  source: SightingSource;
  seenAt: string;
}

/** Sightings of these pilots on these maps in the last SIGHTING_DAYS, newest
 *  first. The caller passes only maps the requester can see. */
export async function listSightings(characterIds: number[], mapIds: string[]): Promise<Sighting[]> {
  if (characterIds.length === 0 || mapIds.length === 0) return [];
  const { rows } = await db.query<{
    character_id: number; character_name: string; corp_id: number | null; alliance_id: number | null;
    eve_system_id: number; system_name: string | null; map_id: string; source: SightingSource; seen_at: Date;
  }>(
    `SELECT s.character_id, s.character_name, s.corp_id, s.alliance_id,
            s.eve_system_id, ss.name AS system_name, s.map_id, s.source, s.seen_at
       FROM pilot_sightings s
       LEFT JOIN solar_systems ss ON ss.id = s.eve_system_id
      WHERE s.character_id = ANY($1::int[])
        AND s.map_id = ANY($2::uuid[])
        AND s.seen_at > NOW() - make_interval(days => $3)
      ORDER BY s.seen_at DESC
      LIMIT $4`,
    [characterIds, mapIds, SIGHTING_DAYS, MAX_LIST_ROWS],
  );
  return rows.map((r) => ({
    characterId: r.character_id,
    name: r.character_name,
    corpId: r.corp_id,
    allianceId: r.alliance_id,
    eveSystemId: r.eve_system_id,
    systemName: r.system_name,
    mapId: r.map_id,
    source: r.source,
    seenAt: r.seen_at.toISOString(),
  }));
}

export async function sweepOldSightings(): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM pilot_sightings WHERE seen_at <= NOW() - make_interval(days => $1)`, [SIGHTING_DAYS]);
  return rowCount ?? 0;
}

const SWEEP_MS = 60 * 60 * 1000;

export function startSightingSweeper(): void {
  const run = () => {
    sweepOldSightings()
      .then((n) => { if (n > 0) log.info(`swept ${n} old sighting(s)`); })
      .catch((err) => log.warn('sighting sweep failed:', err));
  };
  run();
  setInterval(run, SWEEP_MS).unref();
}
