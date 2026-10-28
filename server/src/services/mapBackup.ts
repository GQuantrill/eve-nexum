// A map backup: everything that makes a chain worth having, in one file you can
// import back as a new map. Systems with their notes, labels and intel; every
// connection, broken or not, with its wormhole type, mass jumped, EOL and
// lifetime clocks and flags; and the signatures, anomalies and structures in
// each system, with signatures still linked to the holes they back.
//
// Left out on purpose: who can see the map (shares, share links), saved routes,
// and jump history (other pilots' names and ships).
//
// The file is untrusted on the way back in. parseMapBackup checks every field
// against the same rules the editing routes use (and drops anything else), and
// a system with an EVE id takes its name, class, effect and statics from the
// SDE rather than from the file. It also reads the older export -- the
// client's raw map state -- so those files still import.
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../db.js';

export const BACKUP_FORMAT = 'nexum-map';
export const BACKUP_VERSION = 2;

export const MAX_BACKUP_SYSTEMS     = 500;
export const MAX_BACKUP_CONNECTIONS = 2_000;
export const MAX_BACKUP_SIGNATURES  = 20_000;
export const MAX_BACKUP_ANOMALIES   = 20_000;
export const MAX_BACKUP_STRUCTURES  = 5_000;

const SYSTEM_CLASSES = new Set(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C13', 'HS', 'LS', 'NS', 'Thera', 'Pochven', 'Drifter', 'unknown']);
const EFFECTS        = new Set(['none', 'pulsar', 'black_hole', 'cataclysmic_variable', 'magnetar', 'red_giant', 'wolf_rayet']);
const SYSTEM_STATUS  = new Set(['unknown', 'visited', 'cleared']);
const CONN_TYPES     = new Set(['standard', 'gate', 'jumpgate', 'cyno']);
const MASS_STATUS    = new Set(['stable', 'destabilized', 'critical']);
const TIME_STATUS    = new Set(['fresh', 'eol', 'lessThan24h', 'lessThan4h', 'lessThan1h', 'expired']);
const SIZES          = new Set(['xl', 'large', 'medium', 'small']);
const SIG_TYPES      = new Set(['unknown', 'wormhole', 'data', 'relic', 'combat', 'gas', 'ore', 'ghost']);
const ANOM_TYPES     = new Set(['unknown', 'combat', 'ore', 'homefront']);
const LABELS         = new Set(['a', 'b', 'c', '1', '2', '3']);

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface BackupSystem {
  id: string; eveSystemId: number | null; name: string; alias: string | null;
  systemClass: string; effect: string; statics: string[]; regionName: string | null; npcType: string | null;
  position: { x: number; y: number }; status: string; isHome: boolean; locked: boolean; notes: string;
  intel: string | null; labels: string[]; customLabels: string[]; tag: string | null;
}

export interface BackupConnection {
  id: string; sourceId: string; targetId: string; sourceHandle: string | null; targetHandle: string | null;
  type: string | null; connectionType: string; massStatus: string | null; timeStatus: string | null; size: string;
  massUsed: number; eolAt: string | null; lifetimeExpiresAt: string | null; broken: boolean; brokenAt: string | null;
  flagIcon: string | null; flagNote: string | null; flagBlink: boolean; flagColor: string | null;
  sourceSignatureId: string | null; targetSignatureId: string | null; scoutConnectionId: string | null;
  createdAt: string | null;
}

export interface BackupSignature {
  id: string; systemId: string; sigId: string; sigType: string; name: string; notes: string;
  whType: string; whLeadsTo: string; ghostType: string; massStatus: string; timeStatus: string;
  scoutConnectionId: string | null; createdAt: string | null; updatedAt: string | null;
}

export interface BackupAnomaly {
  id: string; systemId: string; anomId: string; anomType: string; name: string; notes: string;
  createdAt: string | null; updatedAt: string | null;
}

export interface BackupStructure {
  id: string; systemId: string; name: string; structureType: string; ownerCorp: string;
  ownerCorpId: number | null; eveId: string | null; notes: string;
}

export interface BackupSettings {
  lazyRemoveWormholes: boolean;
  collapseGraceHours: number | null;
  bookmarkFormat: string | null;
  siteBookmarkFormat: string | null;
}

export interface MapBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  name: string;
  settings: BackupSettings;
  systems: BackupSystem[];
  connections: BackupConnection[];
  signatures: BackupSignature[];
  anomalies: BackupAnomaly[];
  structures: BackupStructure[];
}

// ── Export ───────────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Everything a backup holds, for one map. The caller checks access. */
export async function buildMapBackup(mapId: string): Promise<MapBackup | null> {
  const { rows: maps } = await db.query<{
    name: string; lazy: boolean; grace: number | null; bm: string | null; sbm: string | null;
  }>(
    `SELECT name, lazy_remove_wormholes AS lazy, collapse_grace_hours AS grace,
            bookmark_format AS bm, site_bookmark_format AS sbm
       FROM maps WHERE id = $1`, [mapId]);
  const map = maps[0];
  if (!map) return null;

  const [sys, conns, sigs, anoms, structs] = await Promise.all([
    db.query<BackupSystem & { x: number; y: number }>(
      `SELECT id, eve_system_id AS "eveSystemId", name, alias, system_class AS "systemClass", effect, statics,
              region_name AS "regionName", npc_type AS "npcType", position_x AS x, position_y AS y, status,
              is_home AS "isHome", locked, notes, intel, labels, custom_labels AS "customLabels", tag
         FROM map_systems WHERE map_id = $1 ORDER BY created_at, id`, [mapId]),
    db.query<Omit<BackupConnection, 'eolAt' | 'lifetimeExpiresAt' | 'brokenAt' | 'createdAt' | 'massUsed'> & {
      massUsed: string; eolAt: Date | null; lifetimeExpiresAt: Date | null; brokenAt: Date | null; createdAt: Date | null;
    }>(
      `SELECT id, source_id AS "sourceId", target_id AS "targetId", source_handle AS "sourceHandle",
              target_handle AS "targetHandle", wh_type AS type, connection_type AS "connectionType",
              mass_status AS "massStatus", time_status AS "timeStatus", size, mass_used AS "massUsed",
              eol_at AS "eolAt", lifetime_expires_at AS "lifetimeExpiresAt", broken, broken_at AS "brokenAt",
              flag_icon AS "flagIcon", flag_note AS "flagNote", flag_blink AS "flagBlink", flag_color AS "flagColor",
              source_signature_id AS "sourceSignatureId", target_signature_id AS "targetSignatureId",
              scout_connection_id AS "scoutConnectionId", created_at AS "createdAt"
         FROM map_connections WHERE map_id = $1 ORDER BY created_at, id`, [mapId]),
    db.query<Omit<BackupSignature, 'createdAt' | 'updatedAt'> & { createdAt: Date | null; updatedAt: Date | null }>(
      `SELECT g.id, g.system_id AS "systemId", g.sig_id AS "sigId", g.sig_type AS "sigType", g.name, g.notes,
              g.wh_type AS "whType", g.wh_leads_to AS "whLeadsTo", g.ghost_type AS "ghostType",
              g.mass_status AS "massStatus", g.time_status AS "timeStatus",
              g.scout_connection_id AS "scoutConnectionId", g.created_at AS "createdAt", g.updated_at AS "updatedAt"
         FROM map_signatures g JOIN map_systems s ON s.id = g.system_id
        WHERE s.map_id = $1 ORDER BY g.created_at, g.id`, [mapId]),
    db.query<Omit<BackupAnomaly, 'createdAt' | 'updatedAt'> & { createdAt: Date | null; updatedAt: Date | null }>(
      `SELECT a.id, a.system_id AS "systemId", a.anom_id AS "anomId", a.anom_type AS "anomType", a.name, a.notes,
              a.created_at AS "createdAt", a.updated_at AS "updatedAt"
         FROM map_anomalies a JOIN map_systems s ON s.id = a.system_id
        WHERE s.map_id = $1 ORDER BY a.created_at, a.id`, [mapId]),
    db.query<BackupStructure>(
      `SELECT t.id, t.system_id AS "systemId", t.name, t.structure_type AS "structureType",
              t.owner_corp AS "ownerCorp", t.owner_corp_id AS "ownerCorpId", t.eve_id::text AS "eveId", t.notes
         FROM map_structures t JOIN map_systems s ON s.id = t.system_id
        WHERE s.map_id = $1 ORDER BY t.created_at, t.id`, [mapId]),
  ]);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    name: map.name,
    settings: {
      lazyRemoveWormholes: map.lazy === true,
      collapseGraceHours: map.grace,
      bookmarkFormat: map.bm,
      siteBookmarkFormat: map.sbm,
    },
    systems: sys.rows.map(({ x, y, ...s }) => ({ ...s, position: { x, y } })),
    connections: conns.rows.map((c) => ({
      ...c, massUsed: Number(c.massUsed) || 0,
      eolAt: iso(c.eolAt), lifetimeExpiresAt: iso(c.lifetimeExpiresAt), brokenAt: iso(c.brokenAt), createdAt: iso(c.createdAt),
    })),
    signatures: sigs.rows.map((g) => ({ ...g, createdAt: iso(g.createdAt), updatedAt: iso(g.updatedAt) })),
    anomalies: anoms.rows.map((a) => ({ ...a, createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt) })),
    structures: structs.rows,
  };
}

// ── Parse (untrusted) ────────────────────────────────────────────────────────

/** Thrown for a file that isn't a map, or is too big to import. */
export class BackupError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) { super(message); }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' ? v.slice(0, max) : fallback);
const strOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
const oneOf = (v: unknown, set: Set<string>, fallback: string): string => (typeof v === 'string' && set.has(v) ? v : fallback);
const oneOfOrNull = (v: unknown, set: Set<string>): string | null => (typeof v === 'string' && set.has(v) ? v : null);
const bool = (v: unknown): boolean => v === true;
// An id the file uses to cross-reference its own rows. Only ever a lookup key
// (never stored), so any short string will do.
const refId = (v: unknown): string | null =>
  (typeof v === 'string' || typeof v === 'number') && String(v).length > 0 && String(v).length <= 64 ? String(v) : null;

const MIN_TIME = Date.UTC(2003, 0, 1);
/** An ISO time from the file, or null. Nothing from the future: a clock that
 *  hasn't started yet would never run out. */
function time(v: unknown, now: number): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < MIN_TIME) return null;
  return new Date(Math.min(t, now)).toISOString();
}
/** A time that may legitimately be ahead (a hole's lifetime end), within reason. */
function futureTime(v: unknown, now: number): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < MIN_TIME || t > now + 30 * 86_400_000) return null;
  return new Date(t).toISOString();
}
const finite = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

const STATIC_RE  = /^[A-Z0-9]{1,8}$/;
const WH_TYPE_RE = /^[A-Z0-9]{1,8}$/;
const INTEL_RE   = /^[A-Za-z0-9-]{1,64}$/;
const TAG_RE     = /^[A-Za-z0-9]$/;
const COLOR_RE   = /^#[0-9a-fA-F]{6}$/;
const SCOUT_RE   = /^[A-Za-z0-9:_.-]{1,64}$/;
const HANDLE_RE  = /^[A-Za-z0-9_-]{1,32}$/;
const COLOR = '(#[0-9a-fA-F]{6})?';
const CUSTOM_LABEL_RES = [
  new RegExp(`^t:${COLOR}:.{1,40}$`), new RegExp(`^i:${COLOR}:[A-Za-z0-9]{1,40}$`), /^t:.{1,40}$/, /^i:[A-Za-z0-9]{1,40}$/,
];

function list<T>(raw: unknown, max: number, what: string, parse: (o: Obj) => T | null): T[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new BackupError(`${what} must be a list`);
  if (raw.length > max) throw new BackupError(`Too many ${what} (max ${max})`, 413);
  const out: T[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const v = parse(r);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Read an uploaded backup -- the current format or the older raw export --
 * into rows that are safe to insert. Anything malformed is dropped or reset to
 * its default rather than failing the whole import; a file that isn't a map at
 * all, or is over the limits, throws BackupError.
 */
export function parseMapBackup(raw: unknown, now = Date.now()): Omit<MapBackup, 'format' | 'version' | 'exportedAt'> {
  if (!isObj(raw) || !Array.isArray(raw.systems) || !Array.isArray(raw.connections)) {
    throw new BackupError('Not a nexum map');
  }
  const s = isObj(raw.settings) ? raw.settings : raw; // the old export kept settings on the map itself
  const grace = typeof s.collapseGraceHours === 'number' && Number.isFinite(s.collapseGraceHours)
    && s.collapseGraceHours >= 0 && s.collapseGraceHours <= 24 ? s.collapseGraceHours : null;
  const fmt = (v: unknown) => { const t = typeof v === 'string' ? v.trim().slice(0, 200) : ''; return t || null; };

  const systems = list(raw.systems, MAX_BACKUP_SYSTEMS, 'systems', (o): BackupSystem | null => {
    const id = refId(o.id);
    if (!id) return null;
    const eve = typeof o.eveSystemId === 'number' && Number.isInteger(o.eveSystemId) && o.eveSystemId > 0 && o.eveSystemId < 2_147_483_647
      ? o.eveSystemId : null;
    const pos = isObj(o.position) ? o.position : {};
    return {
      id, eveSystemId: eve,
      name: str(o.name, 100, 'Unknown').trim() || 'Unknown',
      alias: strOrNull(typeof o.alias === 'string' ? o.alias.trim() : null, 32),
      systemClass: oneOf(o.systemClass, SYSTEM_CLASSES, 'unknown'),
      effect: oneOf(o.effect, EFFECTS, 'none'),
      statics: Array.isArray(o.statics) ? [...new Set(o.statics.filter((x): x is string => typeof x === 'string' && STATIC_RE.test(x)))].slice(0, 6) : [],
      regionName: strOrNull(o.regionName, 100),
      npcType: strOrNull(o.npcType, 64),
      position: { x: finite(pos.x, -1e6, 1e6, 0), y: finite(pos.y, -1e6, 1e6, 0) },
      status: oneOf(o.status, SYSTEM_STATUS, 'unknown'),
      isHome: bool(o.isHome),
      locked: bool(o.locked),
      notes: str(o.notes, 20_000),
      intel: typeof o.intel === 'string' && INTEL_RE.test(o.intel) ? o.intel : null,
      labels: Array.isArray(o.labels) ? [...new Set(o.labels.filter((x): x is string => typeof x === 'string' && LABELS.has(x)))] : [],
      customLabels: Array.isArray(o.customLabels)
        ? o.customLabels.filter((x): x is string => typeof x === 'string' && CUSTOM_LABEL_RES.some((re) => re.test(x))).slice(0, 3)
        : [],
      tag: typeof o.tag === 'string' && TAG_RE.test(o.tag) ? o.tag : null,
    };
  });

  const connections = list(raw.connections, MAX_BACKUP_CONNECTIONS, 'connections', (o): BackupConnection | null => {
    const id = refId(o.id) ?? crypto.randomUUID();
    const sourceId = refId(o.sourceId);
    const targetId = refId(o.targetId);
    if (!sourceId || !targetId) return null;
    const whType = typeof o.type === 'string' ? o.type.toUpperCase() : '';
    const broken = bool(o.broken);
    return {
      id, sourceId, targetId,
      sourceHandle: typeof o.sourceHandle === 'string' && HANDLE_RE.test(o.sourceHandle) ? o.sourceHandle : null,
      targetHandle: typeof o.targetHandle === 'string' && HANDLE_RE.test(o.targetHandle) ? o.targetHandle : null,
      type: WH_TYPE_RE.test(whType) ? whType : null,
      connectionType: oneOf(o.connectionType, CONN_TYPES, 'standard'),
      massStatus: oneOfOrNull(o.massStatus, MASS_STATUS),
      timeStatus: oneOfOrNull(o.timeStatus, TIME_STATUS),
      size: oneOf(o.size, SIZES, 'large'),
      massUsed: Math.round(finite(o.massUsed, 0, 1e13, 0)),
      eolAt: time(o.eolAt, now),
      lifetimeExpiresAt: futureTime(o.lifetimeExpiresAt, now),
      broken,
      // A broken line with no stamp is invisible to the removal sweep.
      brokenAt: broken ? (time(o.brokenAt, now) ?? new Date(now).toISOString()) : null,
      flagIcon: typeof o.flagIcon === 'string' && o.flagIcon.length <= 64 && o.flagIcon !== '' ? o.flagIcon : null,
      flagNote: typeof o.flagNote === 'string' && o.flagNote.length <= 200 && o.flagNote !== '' ? o.flagNote : null,
      flagBlink: bool(o.flagBlink),
      flagColor: typeof o.flagColor === 'string' && COLOR_RE.test(o.flagColor) ? o.flagColor : null,
      sourceSignatureId: refId(o.sourceSignatureId),
      targetSignatureId: refId(o.targetSignatureId),
      scoutConnectionId: typeof o.scoutConnectionId === 'string' && SCOUT_RE.test(o.scoutConnectionId) ? o.scoutConnectionId : null,
      createdAt: time(o.createdAt, now),
    };
  });

  const signatures = list(raw.signatures, MAX_BACKUP_SIGNATURES, 'signatures', (o): BackupSignature | null => {
    const id = refId(o.id);
    const systemId = refId(o.systemId);
    if (!id || !systemId) return null;
    const sigId = typeof o.sigId === 'string' ? o.sigId.trim().toUpperCase() : '';
    const whType = typeof o.whType === 'string' ? o.whType.trim().toUpperCase() : '';
    return {
      id, systemId,
      sigId: /^[A-Z0-9-]{1,7}$/.test(sigId) ? sigId : '',
      sigType: oneOf(o.sigType, SIG_TYPES, 'unknown'),
      name: str(o.name, 200),
      notes: str(o.notes, 2_000),
      whType: WH_TYPE_RE.test(whType) ? whType : '',
      whLeadsTo: str(o.whLeadsTo, 100),
      ghostType: str(o.ghostType, 100),
      massStatus: oneOf(o.massStatus, MASS_STATUS, ''),
      timeStatus: oneOf(o.timeStatus, TIME_STATUS, ''),
      scoutConnectionId: typeof o.scoutConnectionId === 'string' && SCOUT_RE.test(o.scoutConnectionId) ? o.scoutConnectionId : null,
      createdAt: time(o.createdAt, now),
      updatedAt: time(o.updatedAt, now),
    };
  });

  const anomalies = list(raw.anomalies, MAX_BACKUP_ANOMALIES, 'anomalies', (o): BackupAnomaly | null => {
    const id = refId(o.id) ?? crypto.randomUUID();
    const systemId = refId(o.systemId);
    if (!systemId) return null;
    const anomId = typeof o.anomId === 'string' ? o.anomId.trim().toUpperCase() : '';
    return {
      id, systemId,
      anomId: /^[A-Z0-9-]{1,7}$/.test(anomId) ? anomId : '',
      anomType: oneOf(o.anomType, ANOM_TYPES, 'unknown'),
      name: str(o.name, 200),
      notes: str(o.notes, 2_000),
      createdAt: time(o.createdAt, now),
      updatedAt: time(o.updatedAt, now),
    };
  });

  const structures = list(raw.structures, MAX_BACKUP_STRUCTURES, 'structures', (o): BackupStructure | null => {
    const systemId = refId(o.systemId);
    if (!systemId) return null;
    const eveId = typeof o.eveId === 'string' || typeof o.eveId === 'number' ? String(o.eveId) : '';
    return {
      id: refId(o.id) ?? crypto.randomUUID(), systemId,
      name: str(o.name, 200),
      structureType: str(o.structureType, 100),
      ownerCorp: str(o.ownerCorp, 200),
      ownerCorpId: typeof o.ownerCorpId === 'number' && Number.isInteger(o.ownerCorpId) && o.ownerCorpId > 0 && o.ownerCorpId < 2_147_483_647
        ? o.ownerCorpId : null,
      eveId: /^[1-9][0-9]{0,18}$/.test(eveId) ? eveId : null,
      notes: str(o.notes, 2_000),
    };
  });

  return {
    name: str(raw.name, 200, 'Imported Map').trim() || 'Imported Map',
    settings: {
      lazyRemoveWormholes: bool(s.lazyRemoveWormholes),
      collapseGraceHours: grace,
      bookmarkFormat: fmt(s.bookmarkFormat),
      siteBookmarkFormat: fmt(s.siteBookmarkFormat),
    },
    systems, connections, signatures, anomalies, structures,
  };
}

// ── Restore ──────────────────────────────────────────────────────────────────

async function insertBatch(client: PoolClient, table: string, cols: string[], rows: unknown[][], suffix = ''): Promise<number> {
  if (rows.length === 0) return 0;
  const chunkSize = Math.max(1, Math.floor(60_000 / cols.length));
  let n = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: unknown[] = [];
    const ph = chunk.map((r) => {
      const base = values.length;
      values.push(...r);
      return `(${r.map((_, j) => `$${base + j + 1}`).join(',')})`;
    }).join(',');
    const res = await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph} ${suffix}`, values);
    n += res.rowCount ?? 0;
  }
  return n;
}

export interface RestoreCounts {
  systems: number; connections: number; signatures: number; anomalies: number; structures: number;
}

/**
 * Write a parsed backup into `mapId` (a map just created, inside the caller's
 * transaction). Every row gets a fresh id; the file's ids only link its rows to
 * each other. Signatures and anomalies are credited to the importer.
 */
export async function restoreMapBackup(
  client: PoolClient, mapId: string, b: ReturnType<typeof parseMapBackup>, userId: number,
): Promise<RestoreCounts> {
  // A system with an EVE id is that system: take its name, class, effect,
  // statics and region from the SDE, not from the file. One without an id is a
  // placeholder for an unmapped hole; a legacy row with only a name is looked
  // up by name.
  const ids = [...new Set(b.systems.map((s) => s.eveSystemId).filter((x): x is number => x != null))];
  const names = [...new Set(b.systems.filter((s) => s.eveSystemId == null).map((s) => s.name))];
  const sde = new Map<number, { id: number; name: string; cls: string | null; effect: string | null; statics: string[]; region: string | null }>();
  const byName = new Map<string, number>();
  if (ids.length || names.length) {
    const { rows } = await client.query<{ id: number; name: string; cls: string | null; effect: string | null; statics: string[] | null; region: string | null }>(
      `SELECT s.id, s.name, s.class AS cls, s.effect, s.statics, r.name AS region
         FROM solar_systems s LEFT JOIN map_regions r ON r.id = s.region_id
        WHERE s.id = ANY($1::int[]) OR s.name = ANY($2::text[])`, [ids, names]);
    for (const r of rows) {
      sde.set(r.id, { ...r, statics: r.statics ?? [] });
      byName.set(r.name, r.id);
    }
  }

  // Old system id -> new id. One node per EVE system per map: a second row for
  // the same system becomes an alias of the first.
  const sysId = new Map<string, string>();
  const byEve = new Map<number, string>();
  const sysRows: unknown[][] = [];
  for (const s of b.systems) {
    const eve = s.eveSystemId ?? (byName.get(s.name) ?? null);
    const info = eve != null ? sde.get(eve) : undefined;
    if (eve != null && !info) continue;                 // not a real system
    if (eve != null && byEve.has(eve)) { sysId.set(s.id, byEve.get(eve)!); continue; }
    const id = crypto.randomUUID();
    sysId.set(s.id, id);
    if (eve != null) byEve.set(eve, id);
    sysRows.push([
      id, mapId, eve,
      info ? info.name : s.name,
      info ? (info.cls ?? 'unknown') : 'unknown',
      info ? (info.effect ?? 'none') : 'none',
      info ? info.statics : [],
      info ? info.region : null,
      s.npcType, s.position.x, s.position.y, s.status, s.isHome, s.locked, s.notes,
      s.intel, s.labels, s.customLabels, s.tag, s.alias,
    ]);
  }
  const systems = await insertBatch(client, 'map_systems',
    ['id', 'map_id', 'eve_system_id', 'name', 'system_class', 'effect', 'statics', 'region_name', 'npc_type',
     'position_x', 'position_y', 'status', 'is_home', 'locked', 'notes', 'intel', 'labels', 'custom_labels', 'tag', 'alias'],
    sysRows);

  // Signatures before connections, so the links can point at the new rows. A
  // scan id is unique within a system; a repeat aliases to the first.
  const sigId = new Map<string, string>();
  const seenScan = new Map<string, string>();
  const sigRows: unknown[][] = [];
  for (const g of b.signatures) {
    const sys = sysId.get(g.systemId);
    if (!sys) continue;
    const key = g.sigId ? `${sys}|${g.sigId}` : null;
    if (key && seenScan.has(key)) { sigId.set(g.id, seenScan.get(key)!); continue; }
    const id = crypto.randomUUID();
    sigId.set(g.id, id);
    if (key) seenScan.set(key, id);
    sigRows.push([
      id, sys, g.sigId, g.sigType, g.name, g.notes, g.whType, g.whLeadsTo, g.ghostType, g.massStatus, g.timeStatus,
      // Keeps its age: a wormhole signature's lifetime runs from when it was scanned.
      g.createdAt ?? new Date().toISOString(), g.updatedAt ?? g.createdAt ?? new Date().toISOString(),
      userId, true, g.scoutConnectionId,
    ]);
  }
  const signatures = await insertBatch(client, 'map_signatures',
    ['id', 'system_id', 'sig_id', 'sig_type', 'name', 'notes', 'wh_type', 'wh_leads_to', 'ghost_type', 'mass_status',
     'time_status', 'created_at', 'updated_at', 'created_by_user_id', 'from_merge', 'scout_connection_id'],
    sigRows);

  // One connection per pair of systems, no loops.
  const seenPair = new Set<string>();
  const connRows: unknown[][] = [];
  const linked = (id: string | null) => (id ? sigId.get(id) ?? null : null);
  for (const c of b.connections) {
    const src = sysId.get(c.sourceId);
    const tgt = sysId.get(c.targetId);
    if (!src || !tgt || src === tgt) continue;
    const pair = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
    if (seenPair.has(pair)) continue;
    seenPair.add(pair);
    connRows.push([
      crypto.randomUUID(), mapId, src, tgt, c.sourceHandle, c.targetHandle, c.connectionType, c.massStatus,
      c.timeStatus, c.size, c.type, c.massUsed, c.eolAt, c.lifetimeExpiresAt, c.broken, c.brokenAt,
      c.flagIcon, c.flagNote, c.flagBlink, c.flagColor, linked(c.sourceSignatureId), linked(c.targetSignatureId),
      c.scoutConnectionId, c.createdAt ?? new Date().toISOString(),
    ]);
  }
  const connections = await insertBatch(client, 'map_connections',
    ['id', 'map_id', 'source_id', 'target_id', 'source_handle', 'target_handle', 'connection_type', 'mass_status',
     'time_status', 'size', 'wh_type', 'mass_used', 'eol_at', 'lifetime_expires_at', 'broken', 'broken_at',
     'flag_icon', 'flag_note', 'flag_blink', 'flag_color', 'source_signature_id', 'target_signature_id',
     'scout_connection_id', 'created_at'],
    connRows);

  const anomalies = await insertBatch(client, 'map_anomalies',
    ['system_id', 'anom_id', 'anom_type', 'name', 'notes', 'created_by_user_id', 'created_at', 'updated_at'],
    b.anomalies.flatMap((a) => {
      const sys = sysId.get(a.systemId);
      if (!sys) return [];
      const at = a.createdAt ?? new Date().toISOString();
      return [[sys, a.anomId, a.anomType, a.name, a.notes, userId, at, a.updatedAt ?? at]];
    }));

  const structures = await insertBatch(client, 'map_structures',
    ['system_id', 'name', 'structure_type', 'owner_corp', 'eve_id', 'notes', 'created_by_user_id', 'owner_corp_id'],
    b.structures.flatMap((t) => {
      const sys = sysId.get(t.systemId);
      return sys ? [[sys, t.name, t.structureType, t.ownerCorp, t.eveId, t.notes, userId, t.ownerCorpId]] : [];
    }));

  return { systems, connections, signatures, anomalies, structures };
}
