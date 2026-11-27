// Pilot tracking: the pilots someone watches, and what the server's sightings
// (where a pilot was seen, from pinned local pastes and intel lines) add up to.

export interface WatchedPilot { id: number; name: string }

export interface Sighting {
  characterId: number;
  name: string;
  corpId: number | null;
  allianceId: number | null;
  eveSystemId: number;
  systemName: string | null;
  mapId: string;
  source: 'local' | 'intel';
  seenAt: string;
}

/** Synced settings (server allowlist in routes/auth.ts). */
export const WATCH_KEY      = 'nexum.pilots.watched';
/** Mark the systems watched pilots were seen in on the map (default on). */
export const HIGHLIGHT_KEY  = 'nexum.pilots.highlight';
/** The pilot the map's "Watched pilot" heatmap shows, or null. */
export const HEAT_PILOT_KEY = 'nexum.pilots.heatPilot';
/** Only one map's sightings, or '' for every map. */
export const MAP_FILTER_KEY = 'nexum.pilots.mapFilter';

export const MAX_WATCHED = 100;

export function sanitiseWatched(raw: unknown): WatchedPilot[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: WatchedPilot[] = [];
  for (const p of raw) {
    const id = (p as WatchedPilot | null)?.id;
    const name = (p as WatchedPilot | null)?.name;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || typeof name !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= MAX_WATCHED) break;
  }
  return out;
}

export function sanitiseHeatPilot(raw: unknown): WatchedPilot | null {
  return sanitiseWatched([raw])[0] ?? null;
}

export interface SightingSummary {
  count: number;
  /** Distinct systems. */
  systems: number;
  /** The newest sighting (rows arrive newest first). */
  last: Sighting;
}

/** Per pilot: how often, in how many systems, and where last. */
export function summarise(rows: Sighting[]): Map<number, SightingSummary> {
  const out = new Map<number, SightingSummary & { seen: Set<number> }>();
  for (const r of rows) {
    const s = out.get(r.characterId);
    if (!s) out.set(r.characterId, { count: 1, systems: 1, last: r, seen: new Set([r.eveSystemId]) });
    else {
      s.count++;
      if (!s.seen.has(r.eveSystemId)) { s.seen.add(r.eveSystemId); s.systems++; }
    }
  }
  return new Map([...out].map(([id, { count, systems, last }]) => [id, { count, systems, last }]));
}

/** Sightings of one pilot per system: the "Watched pilot" heatmap's values. */
export function heatBySystem(rows: Sighting[], characterId: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of rows) if (r.characterId === characterId) out.set(r.eveSystemId, (out.get(r.eveSystemId) ?? 0) + 1);
  return out;
}

export interface PilotSight { name: string; at: number }

/** Per system, each of these pilots seen there and when they last were,
 *  newest first: the map's sighting markers. */
export function sightsBySystem(rows: Sighting[], ids: ReadonlySet<number>): Map<number, PilotSight[]> {
  const out = new Map<number, PilotSight[]>();
  const done = new Set<string>();
  for (const r of rows) {   // newest first, so the first per pilot and system is the latest
    if (!ids.has(r.characterId)) continue;
    const key = `${r.eveSystemId}:${r.characterId}`;
    if (done.has(key)) continue;
    done.add(key);
    const list = out.get(r.eveSystemId) ?? [];
    list.push({ name: r.name, at: new Date(r.seenAt).getTime() });
    out.set(r.eveSystemId, list);
  }
  return out;
}
