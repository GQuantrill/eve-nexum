// D-scan / local-scan analyser.
//
// A pilot pastes either a directional scan or a list of names copied from
// local chat; we work out which it is, break it down, and keep the result for a
// day under an unguessable id so the link can be passed round a fleet. Anyone
// can make one, logged in or not. A logged-in pilot can also pin a scan to a
// system on a map they can write, which lists it in that system's panel.
//
// The paste is analysed HERE, not in the browser: the type -> group -> category
// data lives in Postgres (SDE), the local lookup needs ESI, and a stored result
// must not be something the client was free to make up.
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { esiFetch } from '../utils/esi.js';
import { createLogger } from '../utils/logger.js';
import { resolveEntityNames } from './entityNames.js';

const log = createLogger('dscan');

/** How long a scan link stays viewable. A d-scan is stale in minutes; a day
 *  covers the after-action chat. */
export const DSCAN_TTL_HOURS = 24;

/** Bounds on a paste. EVE's own d-scan tops out well below the first; local
 *  is capped lower because every name costs ESI work. */
export const MAX_DSCAN_LINES = 5_000;
export const MAX_LOCAL_NAMES = 3_000;
// A full 5,000-line scan is ~200 KB; this leaves room without letting one
// anonymous request park megabytes for a day.
export const MAX_PASTE_CHARS = 400_000;

/** Things this close count as on grid. Grids vary, but 10,000 km covers the
 *  usual one with room to spare and is what pilots expect to see split out. */
export const ON_GRID_KM = 10_000;

const AU_KM = 149_597_870.7;

// ── Parsing (pure) ───────────────────────────────────────────────────────────

export interface DscanRow {
  typeId:     number;
  name:       string;        // the item's own name ("Bob's Loki", "Planet III")
  typeName:   string;        // the type as the pasting client named it
  distanceKm: number | null; // null when the client showed "-"
}

/**
 * A distance as the d-scan window prints it, in km.
 *
 * The client formats numbers in the player's locale, so "1,234 km", "1.234 km"
 * and "1 234 km" are all the same distance, and an AU figure carries a decimal
 * ("4.2 AU" or "4,2 AU"). One rule covers them: a final separator followed by
 * exactly three digits is a thousands separator, anything else is the decimal.
 */
export function parseDistanceKm(raw: string): number | null {
  const s = raw.trim();
  const m = /^([\d.,'\s  ]+?)\s*(m|km|au)$/i.exec(s);
  if (!m) return null;
  let num = m[1].replace(/[\s  ']/g, '');
  const last = Math.max(num.lastIndexOf(','), num.lastIndexOf('.'));
  if (last >= 0) {
    const intPart = num.slice(0, last).replace(/[.,]/g, '');
    const tail = num.slice(last + 1);
    num = tail.length === 3 ? intPart + tail : `${intPart}.${tail}`;
  }
  const v = Number(num);
  if (!Number.isFinite(v)) return null;
  const unit = m[2].toLowerCase();
  return unit === 'm' ? v / 1000 : unit === 'au' ? v * AU_KM : v;
}

/** One d-scan line: typeID, name, type name, distance -- tab separated. */
export function parseDscanLine(line: string): DscanRow | null {
  const cols = line.split('\t');
  if (cols.length < 4) return null;
  const id = cols[0].trim();
  if (!/^\d{1,10}$/.test(id)) return null;
  const typeId = Number(id);
  if (typeId <= 0 || typeId > 2_147_483_647) return null;
  return {
    typeId,
    name:       cols[1].trim().slice(0, 100),
    typeName:   cols[2].trim().slice(0, 100),
    distanceKm: parseDistanceKm(cols[3]),
  };
}

// EVE character names: 3-37 characters of letters, digits, space, apostrophe,
// hyphen and period.
const CHAR_NAME_RE = /^[A-Za-z0-9 '.\-]{3,37}$/;

export type ParsedPaste =
  | { kind: 'dscan'; rows: DscanRow[] }
  | { kind: 'local'; names: string[] }
  | { kind: 'error'; error: 'empty' | 'unrecognised' | 'too_many' };

/**
 * Work out what was pasted.
 *
 * A d-scan is tab-separated with a numeric type id up front; a local list is
 * one name per line. Mostly-d-scan wins, so a stray header or blank-ish line
 * doesn't sink an otherwise good scan. A local list must be all names: a line
 * that isn't one means it wasn't a local paste.
 */
export function parsePaste(text: string): ParsedPaste {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { kind: 'error', error: 'empty' };

  const rows: DscanRow[] = [];
  for (const l of lines) {
    const r = parseDscanLine(l);
    if (r) rows.push(r);
  }
  if (rows.length > 0 && rows.length * 2 >= lines.length) {
    if (rows.length > MAX_DSCAN_LINES) return { kind: 'error', error: 'too_many' };
    return { kind: 'dscan', rows };
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const l of lines) {
    const n = l.trim();
    if (!CHAR_NAME_RE.test(n)) return { kind: 'error', error: 'unrecognised' };
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    names.push(n);
  }
  if (names.length > MAX_LOCAL_NAMES) return { kind: 'error', error: 'too_many' };
  return { kind: 'local', names };
}

// ── Analysis ─────────────────────────────────────────────────────────────────

/** Which part of the breakdown a category belongs in. */
export type DscanSection = 'ship' | 'structure' | 'deployable' | 'drone' | 'other';

// SDE category ids.
const SECTION_BY_CATEGORY: Record<number, DscanSection> = {
  6:  'ship',
  3:  'structure',   // Station
  23: 'structure',   // Starbase
  40: 'structure',   // Sovereignty Structures
  65: 'structure',   // Structure (Upwell)
  22: 'deployable',
  18: 'drone',
  87: 'drone',       // Fighter
};

export function sectionFor(categoryId: number | null): DscanSection {
  return (categoryId != null && SECTION_BY_CATEGORY[categoryId]) || 'other';
}

export interface DscanTypeInfo {
  n: string;            // type name
  g: string;            // group name (ship class for ships)
  s: DscanSection;
  m: number | null;     // hull mass, kg
}

/** The system a scan was taken in, and how we know: a Sun in the paste names
 *  it outright; otherwise it's the map system the scan was pinned to. */
export interface ScanSystem {
  id:   number;
  name: string;
  from: 'sun' | 'map';
}

export interface DscanData {
  kind: 'dscan';
  system?: ScanSystem;
  onGridKm: number;
  types: Record<string, DscanTypeInfo>;
  /** [typeId, item name, distance km | null] -- compact, a big scan is long. */
  rows: Array<[number, string, number | null]>;
}

export interface LocalPilot {
  n: string;            // name as ESI spells it
  id: number;
  c: number | null;     // corporation id
  a: number | null;     // alliance id
}

export interface LocalData {
  kind: 'local';
  system?: ScanSystem;
  pilots: LocalPilot[];
  /** Names ESI didn't recognise (typos, biomassed characters). */
  unknown: string[];
  /** Corp and alliance names, by id. */
  names: Record<string, string>;
}

export type ScanData = DscanData | LocalData;

/** The headline numbers, kept beside the row so a list needn't load the scan. */
export type ScanSummary =
  | { kind: 'dscan'; total: number; ships: number }
  | { kind: 'local'; pilots: number };

// SDE group id of suns. Every system has exactly one, so a Sun on the scan
// says where it was taken.
const SUN_GROUP_ID = 6;

/**
 * The system a sun's d-scan name points to. The client names a star
 * "<system> - Star" (the suffix in the player's language), and system names
 * never contain " - ", so the system is everything before the last one.
 */
export function systemNameFromSun(sunName: string): string | null {
  const cut = sunName.lastIndexOf(' - ');
  const name = (cut > 0 ? sunName.slice(0, cut) : sunName).trim();
  return name ? name : null;
}

export async function systemFromSun(sunNames: string[]): Promise<ScanSystem | null> {
  const wanted = [...new Set(sunNames.map(systemNameFromSun).filter((n): n is string => !!n))];
  if (wanted.length === 0) return null;
  try {
    const { rows } = await db.query<{ id: number; name: string }>(
      `SELECT id, name FROM solar_systems WHERE lower(name) = ANY($1::text[]) LIMIT 1`,
      [wanted.map((n) => n.toLowerCase())]);
    return rows[0] ? { id: rows[0].id, name: rows[0].name, from: 'sun' } : null;
  } catch (err) {
    // No SDE systems table (a fresh install before setup-db): the scan is
    // still worth saving, just without a system.
    log.warn('sun system lookup failed:', err);
    return null;
  }
}

export async function analyseDscan(rows: DscanRow[]): Promise<DscanData> {
  const ids = [...new Set(rows.map((r) => r.typeId))];
  const { rows: found } = await db.query<{
    id: number; name: string; group_id: number; group_name: string; category_id: number; mass: string | null;
  }>(
    `SELECT t.id, t.name, t.group_id, g.name AS group_name, g.category_id, t.mass
       FROM item_types t JOIN item_groups g ON g.id = t.group_id
      WHERE t.id = ANY($1::int[])`,
    [ids],
  );
  const types: Record<string, DscanTypeInfo> = {};
  const sunTypes = new Set<number>();
  for (const f of found) {
    if (f.group_id === SUN_GROUP_ID) sunTypes.add(f.id);
    const mass = f.mass == null ? null : Number(f.mass);
    types[f.id] = {
      n: f.name, g: f.group_name, s: sectionFor(f.category_id),
      m: mass != null && Number.isFinite(mass) ? mass : null,
    };
  }
  // A type the SDE doesn't know yet (released since the last import) keeps the
  // name the paste gave it rather than vanishing from the scan.
  for (const r of rows) {
    if (!types[r.typeId]) types[r.typeId] = { n: r.typeName || String(r.typeId), g: '', s: 'other', m: null };
  }
  const system = await systemFromSun(rows.filter((r) => sunTypes.has(r.typeId)).map((r) => r.name));
  return {
    kind: 'dscan', onGridKm: ON_GRID_KM, types,
    ...(system ? { system } : {}),
    rows: rows.map((r) => [r.typeId, r.name, r.distanceKm == null ? null : Math.round(r.distanceKm)]),
  };
}

const ESI = 'https://esi.evetech.net/latest';
const ESI_TIMEOUT_MS = 10_000;
const IDS_BATCH = 500;          // /universe/ids/ limit
const AFFILIATION_BATCH = 1000; // /characters/affiliation/ limit

async function esiPost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await esiFetch(`${ESI}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ESI_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`ESI ${path} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.warn(`ESI ${path} failed:`, err);
    return null;
  }
}

/** Thrown when ESI couldn't resolve any of a local list, so the caller can
 *  say "try again" instead of saving a scan of nobody. */
export class LocalLookupError extends Error {}

export async function analyseLocal(names: string[]): Promise<LocalData> {
  const byName = new Map<string, { id: number; name: string }>();
  let anyBatchOk = false;
  for (let i = 0; i < names.length; i += IDS_BATCH) {
    const body = await esiPost<{ characters?: Array<{ id: number; name: string }> }>(
      '/universe/ids/', names.slice(i, i + IDS_BATCH));
    if (!body) continue;
    anyBatchOk = true;
    for (const c of body.characters ?? []) byName.set(c.name.toLowerCase(), c);
  }
  if (!anyBatchOk) throw new LocalLookupError('ESI name lookup failed');

  const chars = [...byName.values()];
  const aff = new Map<number, { c: number | null; a: number | null }>();
  for (let i = 0; i < chars.length; i += AFFILIATION_BATCH) {
    const body = await esiPost<Array<{ character_id: number; corporation_id?: number; alliance_id?: number }>>(
      '/characters/affiliation/', chars.slice(i, i + AFFILIATION_BATCH).map((c) => c.id));
    for (const r of body ?? []) aff.set(r.character_id, { c: r.corporation_id ?? null, a: r.alliance_id ?? null });
  }

  const pilots: LocalPilot[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const hit = byName.get(n.toLowerCase());
    if (!hit) { unknown.push(n); continue; }
    const a = aff.get(hit.id);
    pilots.push({ n: hit.name, id: hit.id, c: a?.c ?? null, a: a?.a ?? null });
  }

  const orgIds = new Set<number>();
  for (const p of pilots) { if (p.c) orgIds.add(p.c); if (p.a) orgIds.add(p.a); }
  const resolved = await resolveEntityNames([...orgIds]);
  const orgNames: Record<string, string> = {};
  for (const [id, e] of resolved) orgNames[id] = e.name;

  return { kind: 'local', pilots, unknown, names: orgNames };
}

export function summarise(data: ScanData): ScanSummary {
  if (data.kind === 'local') return { kind: 'local', pilots: data.pilots.length };
  const ships = data.rows.filter(([id]) => data.types[id]?.s === 'ship').length;
  return { kind: 'dscan', total: data.rows.length, ships };
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** 96 random bits, URL-safe: 16 characters. Unguessable, so the link is the
 *  only way in. */
export function newScanId(): string {
  return randomBytes(12).toString('base64url');
}
export const SCAN_ID_RE = /^[A-Za-z0-9_-]{16}$/;

export interface SaveScanInput {
  data: ScanData;
  createdBy: number | null;
  mapId: string | null;
  eveSystemId: number | null;
}

export async function saveScan(input: SaveScanInput): Promise<{ id: string; expiresAt: string }> {
  const id = newScanId();
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO dscans (id, kind, data, summary, expires_at, created_by, map_id, eve_system_id)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(hours => $5), $6, $7, $8)
     RETURNING expires_at`,
    [id, input.data.kind, JSON.stringify(input.data), JSON.stringify(summarise(input.data)),
     DSCAN_TTL_HOURS, input.createdBy, input.mapId, input.eveSystemId],
  );
  return { id, expiresAt: rows[0].expires_at.toISOString() };
}

export type ScanLookup =
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'ok'; scan: { id: string; kind: string; createdAt: string; expiresAt: string; data: ScanData } };

export async function getScan(id: string): Promise<ScanLookup> {
  if (!SCAN_ID_RE.test(id)) return { status: 'not_found' };
  const { rows } = await db.query<{ id: string; kind: string; data: ScanData; created_at: Date; expires_at: Date }>(
    `SELECT id, kind, data, created_at, expires_at FROM dscans WHERE id = $1`, [id]);
  const r = rows[0];
  if (!r) return { status: 'not_found' };
  // The sweep runs hourly; between runs an expired row is still there, and the
  // link must stop working on time regardless.
  if (r.expires_at.getTime() <= Date.now()) return { status: 'expired' };
  return {
    status: 'ok',
    scan: {
      id: r.id, kind: r.kind, data: r.data,
      createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(),
    },
  };
}

export interface SystemScanEntry {
  id: string;
  createdAt: string;
  summary: ScanSummary;
}

/** Live scans pinned to one system on one map, newest first. */
export async function listSystemScans(mapId: string, eveSystemId: number): Promise<SystemScanEntry[]> {
  const { rows } = await db.query<{ id: string; created_at: Date; summary: ScanSummary }>(
    `SELECT id, created_at, summary FROM dscans
      WHERE map_id = $1 AND eve_system_id = $2 AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 50`,
    [mapId, eveSystemId],
  );
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at.toISOString(), summary: r.summary }));
}

export async function sweepExpiredScans(): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM dscans WHERE expires_at <= NOW()`);
  return rowCount ?? 0;
}

const SWEEP_MS = 60 * 60 * 1000;

export function startDscanSweeper(): void {
  const run = () => {
    sweepExpiredScans()
      .then((n) => { if (n > 0) log.info(`swept ${n} expired scan(s)`); })
      .catch((err) => log.warn('dscan sweep failed:', err));
  };
  run();
  setInterval(run, SWEEP_MS).unref();
}
