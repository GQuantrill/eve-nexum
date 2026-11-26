import { db } from '../db.js';
import { blueLootSystems } from './blueLoot.js';

// The candidate systems for each Closest Systems suggestion the server knows
// (routes/route.ts POST /nearest). Sets the browser already holds (A0s, your
// clones, Thera exits, incursions, structures) are sent in by the client.

export const MAIN_HUBS = ['Jita', 'Amarr', 'Dodixie', 'Rens', 'Hek'];
export const SECONDARY_HUBS = ['Perimeter', 'Ashab', 'Botane', 'Oursulaert', 'Sobaseki', 'Tash-Murkon Prime'];

/** Station services offered as a suggestion (SDE stationServices ids). */
export const STATION_SERVICES = {
  cloning:     10,
  jumpClone:   24,
  repair:      13,
  fitting:     17,
  market:      7,
  reprocessing: 5,
  insurance:   21,
} as const;
export type StationService = keyof typeof STATION_SERVICES;

const CONCORD_CORP = 1000125;
const LP_STORE     = 25;
/** Pochven: -1.0 like null-sec, but nobody means it by "null-sec". */
const POCHVEN_REGION = 10000070;

export type ServerKind =
  | 'hub' | 'hub2' | 'highsec' | 'lowsec' | 'nullsec' | 'kspace'
  | 'station' | 'concord' | 'blueloot' | `service:${StationService}`;

export function isServerKind(k: string): k is ServerKind {
  if (['hub', 'hub2', 'highsec', 'lowsec', 'nullsec', 'kspace', 'station', 'concord', 'blueloot'].includes(k)) return true;
  return k.startsWith('service:') && k.slice(8) in STATION_SERVICES;
}

interface SystemRow { id: number; name: string; security: number; region_id: number | null }
let systems: SystemRow[] | null = null;

/** Every k-space system on the gate network, loaded once. */
async function kspaceSystems(): Promise<SystemRow[]> {
  if (systems) return systems;
  const { rows } = await db.query<{ id: number; name: string; security: string; region_id: number | null }>(
    `SELECT id, name, security::text AS security, region_id FROM solar_systems
      WHERE id IN (SELECT DISTINCT system_id FROM map_stargates)`);
  systems = rows.map((r) => ({ ...r, security: Number(r.security) }));
  return systems;
}

// EVE's bands: 0.45 and up shows as 0.5 (high-sec); anything above 0.0 is
// low-sec (0.01 shows as 0.1); 0.0 and below is null-sec.
const isHigh = (s: SystemRow) => s.security >= 0.45;
const isLow  = (s: SystemRow) => s.security > 0 && s.security < 0.45;
const isNull = (s: SystemRow) => s.security <= 0 && s.region_id !== POCHVEN_REGION;

async function stationSystems(where = 'TRUE', params: unknown[] = []): Promise<Set<number>> {
  const { rows } = await db.query<{ solar_system_id: number }>(
    `SELECT DISTINCT solar_system_id FROM npc_stations WHERE solar_system_id IS NOT NULL AND ${where}`, params);
  return new Set(rows.map((r) => r.solar_system_id));
}

/** The kind's systems, and for blue loot the items each buys. */
export async function serverKindTargets(
  kind: ServerKind,
): Promise<{ ids: Set<number>; detail?: Map<number, number[]> }> {
  const all = await kspaceSystems();
  switch (kind) {
    case 'hub':
    case 'hub2': {
      const names = new Set(kind === 'hub' ? MAIN_HUBS : SECONDARY_HUBS);
      return { ids: new Set(all.filter((s) => names.has(s.name)).map((s) => s.id)) };
    }
    case 'highsec': return { ids: new Set(all.filter(isHigh).map((s) => s.id)) };
    case 'lowsec':  return { ids: new Set(all.filter(isLow).map((s) => s.id)) };
    case 'nullsec': return { ids: new Set(all.filter(isNull).map((s) => s.id)) };
    case 'kspace':  return { ids: new Set(all.map((s) => s.id)) };
    case 'station': return { ids: await stationSystems() };
    case 'concord': return { ids: await stationSystems('owner_id = $1 AND $2 = ANY(services)', [CONCORD_CORP, LP_STORE]) };
    case 'blueloot': {
      const detail = await blueLootSystems();
      return { ids: new Set(detail.keys()), detail };
    }
    default: {
      const service = STATION_SERVICES[kind.slice(8) as StationService];
      return { ids: await stationSystems('$1 = ANY(services)', [service]) };
    }
  }
}

/** Tests only. */
export function resetNearestSetsForTest(): void { systems = null; }
