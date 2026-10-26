// Turning a stored scan (server/src/services/dscan.ts) into what the page shows.
// The server stores the rows compactly; grouping, filtering by grid and
// totting up mass happen here so one stored scan can be viewed either way.

export type DscanSection = 'ship' | 'structure' | 'deployable' | 'drone' | 'other';

export interface DscanTypeInfo { n: string; g: string; s: DscanSection; m: number | null }

export interface DscanData {
  kind: 'dscan';
  onGridKm: number;
  types: Record<string, DscanTypeInfo>;
  rows: Array<[number, string, number | null]>;
}

export interface LocalPilot { n: string; id: number; c: number | null; a: number | null }

export interface LocalData {
  kind: 'local';
  pilots: LocalPilot[];
  unknown: string[];
  names: Record<string, string>;
}

export type ScanData = DscanData | LocalData;

export interface StoredScan {
  id: string;
  kind: 'dscan' | 'local';
  createdAt: string;
  expiresAt: string;
  data: ScanData;
}

export type ScanSummary =
  | { kind: 'dscan'; total: number; ships: number }
  | { kind: 'local'; pilots: number };

export interface SystemScanEntry { id: string; createdAt: string; summary: ScanSummary }

/** Which rows to count: everything, or only what's on / off grid. */
export type GridFilter = 'all' | 'on' | 'off';

export function onGrid(distanceKm: number | null, limitKm: number): boolean {
  return distanceKm != null && distanceKm <= limitKm;
}

export interface TypeCount { typeId: number; name: string; count: number; mass: number | null }
export interface GroupCount { group: string; count: number; types: TypeCount[] }

export interface DscanBreakdown {
  /** Rows passing the filter. */
  total: number;
  /** Counts on and off grid, ignoring the filter, for the toggle labels. */
  onGrid: number;
  offGrid: number;
  sections: Record<DscanSection, GroupCount[]>;
  sectionTotals: Record<DscanSection, number>;
  /** Hull mass of every ship that passes the filter, kg. */
  shipMass: number;
  /** Ships whose type has no mass on record, so the total is a floor. */
  shipsWithoutMass: number;
}

const SECTIONS: DscanSection[] = ['ship', 'structure', 'deployable', 'drone', 'other'];

const byCountThenName = <T extends { count: number }>(name: (x: T) => string) =>
  (a: T, b: T) => b.count - a.count || name(a).localeCompare(name(b));

export function breakdown(data: DscanData, filter: GridFilter = 'all'): DscanBreakdown {
  const sections = Object.fromEntries(SECTIONS.map((s) => [s, [] as GroupCount[]])) as Record<DscanSection, GroupCount[]>;
  const sectionTotals = Object.fromEntries(SECTIONS.map((s) => [s, 0])) as Record<DscanSection, number>;
  const groups = new Map<string, Map<number, TypeCount>>(); // `${section}|${group}` -> types
  let total = 0, on = 0, off = 0, shipMass = 0, shipsWithoutMass = 0;

  for (const [typeId, , dist] of data.rows) {
    const isOn = onGrid(dist, data.onGridKm);
    if (isOn) on++; else off++;
    if (filter === 'on' && !isOn) continue;
    if (filter === 'off' && isOn) continue;
    total++;

    const info = data.types[typeId] ?? { n: String(typeId), g: '', s: 'other' as const, m: null };
    sectionTotals[info.s]++;
    if (info.s === 'ship') {
      if (info.m != null) shipMass += info.m; else shipsWithoutMass++;
    }
    const key = `${info.s}|${info.g}`;
    let types = groups.get(key);
    if (!types) { types = new Map(); groups.set(key, types); }
    const tc = types.get(typeId);
    if (tc) tc.count++;
    else types.set(typeId, { typeId, name: info.n, count: 1, mass: info.m });
  }

  for (const [key, types] of groups) {
    const [s, group] = key.split('|') as [DscanSection, string];
    const list = [...types.values()].sort(byCountThenName((x) => x.name));
    sections[s].push({ group, count: list.reduce((n, x) => n + x.count, 0), types: list });
  }
  for (const s of SECTIONS) sections[s].sort(byCountThenName((x) => x.group));

  return { total, onGrid: on, offGrid: off, sections, sectionTotals, shipMass, shipsWithoutMass };
}

export interface CorpCount { id: number | null; name: string; count: number }
export interface AllianceCount { id: number | null; name: string; count: number; corps: CorpCount[] }

/**
 * Local pilots by alliance, then corp. Pilots in a corp with no alliance sit
 * under a single "no alliance" bucket (id null) so they still group by corp.
 */
export function localBreakdown(data: LocalData): AllianceCount[] {
  const nameOf = (id: number | null) => (id != null ? data.names[id] ?? `#${id}` : '');
  const alliances = new Map<number | null, Map<number | null, number>>();
  for (const p of data.pilots) {
    let corps = alliances.get(p.a);
    if (!corps) { corps = new Map(); alliances.set(p.a, corps); }
    corps.set(p.c, (corps.get(p.c) ?? 0) + 1);
  }
  const out: AllianceCount[] = [];
  for (const [aid, corps] of alliances) {
    const list = [...corps].map(([cid, count]) => ({ id: cid, name: nameOf(cid), count }))
      .sort(byCountThenName((x) => x.name));
    out.push({ id: aid, name: nameOf(aid), count: list.reduce((n, c) => n + c.count, 0), corps: list });
  }
  // No-alliance bucket last regardless of size: it isn't one group of people.
  return out.sort((a, b) => (a.id == null ? 1 : 0) - (b.id == null ? 1 : 0) || b.count - a.count || a.name.localeCompare(b.name));
}

/** The shareable page for a scan. Hash-routed, like every other page. */
export function scanUrl(id: string): string {
  return `${window.location.origin}/#/dscan/${id}`;
}

export const SCAN_ROUTE_RE = /^\/dscan(?:\/([A-Za-z0-9_-]{16}))?\/?$/;
