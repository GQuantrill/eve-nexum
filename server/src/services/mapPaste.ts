// Copy and paste systems between maps. Copy takes the selected systems from a
// map, with the links between them and their signatures, anomalies and
// structures, in the backup format (mapBackup.ts), so it goes through the
// clipboard and works between two nexum servers too. Paste folds that into an
// existing map:
//
// - A system the map already has stays as it is (the map you paste into wins);
//   only what it is missing is added: signatures by scan id, anomalies by id,
//   structures by EVE id or name, links by the pair of systems.
// - New systems keep their layout relative to each other. If any of them is
//   already on the map, the group lines up on that system; otherwise it goes
//   where the pilot pasted. Then they are pushed clear of the systems already
//   there, which never move.
//
// The clip is untrusted (it came off the clipboard): it goes through
// parseMapBackup like an imported file before it gets here.
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { insertBatch, lookupSde, type MapBackup, type parseMapBackup } from './mapBackup.js';

export const CLIP_FORMAT = 'nexum-systems';

type Parsed = ReturnType<typeof parseMapBackup>;

/** The selected systems out of a full backup, with what belongs to them. */
export type MapClip = Omit<MapBackup, 'format'> & { format: typeof CLIP_FORMAT };

export function selectClip(b: MapBackup, systemIds: ReadonlySet<string>): MapClip {
  const systems = b.systems.filter((s) => systemIds.has(s.id));
  const keep = new Set(systems.map((s) => s.id));
  const signatures = b.signatures.filter((g) => keep.has(g.systemId));
  const sigIds = new Set(signatures.map((g) => g.id));
  return {
    ...b,
    format: CLIP_FORMAT,
    systems,
    connections: b.connections
      .filter((c) => keep.has(c.sourceId) && keep.has(c.targetId))
      .map((c) => ({
        ...c,
        sourceSignatureId: c.sourceSignatureId && sigIds.has(c.sourceSignatureId) ? c.sourceSignatureId : null,
        targetSignatureId: c.targetSignatureId && sigIds.has(c.targetSignatureId) ? c.targetSignatureId : null,
      })),
    signatures,
    anomalies: b.anomalies.filter((a) => keep.has(a.systemId)),
    structures: b.structures.filter((t) => keep.has(t.systemId)),
  };
}

// Node boxes, as the importers assume: nodes are much wider than tall.
const MIN_X = 240, MIN_Y = 160;

/**
 * Push each moving box clear of the fixed ones and of the moving ones already
 * placed, along the shallower axis of each overlap; one still stuck after that
 * steps down until it is clear. Fixed boxes never move, and a group that
 * overlaps nothing keeps its layout exactly.
 */
export function placeClear(moving: { x: number; y: number }[], fixed: { x: number; y: number }[]): void {
  const placed = [...fixed];
  const hit = (a: { x: number; y: number }) =>
    placed.find((f) => Math.abs(a.x - f.x) < MIN_X && Math.abs(a.y - f.y) < MIN_Y);
  for (const a of moving) {
    for (let n = 0; n < 50; n++) {
      const f = hit(a);
      if (!f) break;
      const dx = a.x - f.x, dy = a.y - f.y;
      const ox = MIN_X - Math.abs(dx), oy = MIN_Y - Math.abs(dy);
      if (ox <= oy) a.x += (dx < 0 ? -1 : 1) * ox; else a.y += (dy < 0 ? -1 : 1) * oy;
    }
    let f = hit(a);
    while (f) { a.y = f.y + MIN_Y; f = hit(a); }
    placed.push(a);
  }
}

/**
 * Where the new systems go: lined up on the first pasted system the map
 * already has, else centred on the anchor (where the pilot pasted), else to
 * the right of everything on the map. Returns the offset to add.
 */
export function pasteOffset(
  newPos: { x: number; y: number }[],
  matched: { sx: number; sy: number; dx: number; dy: number }[],
  existing: { x: number; y: number }[],
  anchor: { x: number; y: number } | null,
): { x: number; y: number } {
  if (matched.length) return { x: matched[0].dx - matched[0].sx, y: matched[0].dy - matched[0].sy };
  if (!newPos.length) return { x: 0, y: 0 };
  const minX = Math.min(...newPos.map((p) => p.x)), maxX = Math.max(...newPos.map((p) => p.x));
  const minY = Math.min(...newPos.map((p) => p.y)), maxY = Math.max(...newPos.map((p) => p.y));
  if (anchor) return { x: anchor.x - (minX + maxX) / 2, y: anchor.y - (minY + maxY) / 2 };
  if (!existing.length) return { x: -minX, y: -minY };
  return {
    x: Math.max(...existing.map((p) => p.x)) + MIN_X * 1.5 - minX,
    y: Math.min(...existing.map((p) => p.y)) - minY,
  };
}

export interface PasteCounts {
  systems: number; connections: number; signatures: number; anomalies: number; structures: number;
  /** Pasted systems the map already had. */
  matched: number;
  /** Where to look: the middle of the pasted group, in map coordinates. */
  focus: { x: number; y: number } | null;
}

export async function pasteIntoMap(
  client: PoolClient, mapId: string, clip: Parsed, userId: number, anchor: { x: number; y: number } | null,
): Promise<PasteCounts> {
  const { sde, byName } = await lookupSde(client, clip.systems);

  const destSys = await client.query<{ id: string; eve: number | null; x: number; y: number }>(
    `SELECT id, eve_system_id AS eve, position_x AS x, position_y AS y FROM map_systems WHERE map_id = $1`, [mapId]);
  const destByEve = new Map<number, { id: string; x: number; y: number }>();
  for (const d of destSys.rows) if (d.eve != null) destByEve.set(d.eve, d);

  // Clip system id -> map system id.
  const sysId = new Map<string, string>();
  const byEve = new Map<number, string>();
  const matched: { sx: number; sy: number; dx: number; dy: number }[] = [];
  const fresh: { s: Parsed['systems'][number]; id: string; eve: number | null; x: number; y: number }[] = [];
  for (const s of clip.systems) {
    const eve = s.eveSystemId ?? (byName.get(s.name) ?? null);
    if (eve != null && !sde.has(eve)) continue;          // not a real system
    const there = eve != null ? destByEve.get(eve) : undefined;
    if (there) {
      sysId.set(s.id, there.id);
      matched.push({ sx: s.position.x, sy: s.position.y, dx: there.x, dy: there.y });
      continue;
    }
    if (eve != null && byEve.has(eve)) { sysId.set(s.id, byEve.get(eve)!); continue; }
    const id = crypto.randomUUID();
    sysId.set(s.id, id);
    if (eve != null) byEve.set(eve, id);
    fresh.push({ s, id, eve, x: s.position.x, y: s.position.y });
  }

  const off = pasteOffset(fresh, matched, destSys.rows, anchor);
  for (const f of fresh) { f.x += off.x; f.y += off.y; }
  placeClear(fresh, destSys.rows);

  const systems = await insertBatch(client, 'map_systems',
    ['id', 'map_id', 'eve_system_id', 'name', 'system_class', 'effect', 'statics', 'region_name', 'npc_type',
     'position_x', 'position_y', 'status', 'is_home', 'locked', 'notes', 'intel', 'labels', 'custom_labels', 'tag', 'alias'],
    fresh.map(({ s, id, eve, x, y }) => {
      const info = eve != null ? sde.get(eve) : undefined;
      return [
        id, mapId, eve,
        info ? info.name : s.name,
        info ? (info.cls ?? 'unknown') : 'unknown',
        info ? (info.effect ?? 'none') : 'none',
        info ? info.statics : [],
        info ? info.region : null,
        // Never the map's home: that is one system the map's owner picks.
        s.npcType, x, y, s.status, false, s.locked, s.notes,
        s.intel, s.labels, s.customLabels, s.tag, s.alias,
      ];
    }));

  const targetIds = [...new Set(sysId.values())];

  // Signatures: only scan ids the system doesn't have yet. One it has already
  // stands in for the pasted one, so a pasted link can still point at it.
  const haveSig = new Map<string, string>();
  const sigRes = await client.query<{ id: string; systemId: string; sigId: string }>(
    `SELECT id, system_id AS "systemId", sig_id AS "sigId" FROM map_signatures
      WHERE system_id = ANY($1::uuid[]) AND sig_id <> ''`, [targetIds]);
  for (const g of sigRes.rows) haveSig.set(`${g.systemId}|${g.sigId.toUpperCase()}`, g.id);
  const sigId = new Map<string, string>();
  const sigRows: unknown[][] = [];
  for (const g of clip.signatures) {
    const sys = sysId.get(g.systemId);
    if (!sys) continue;
    const key = g.sigId ? `${sys}|${g.sigId.toUpperCase()}` : null;
    if (key && haveSig.has(key)) { sigId.set(g.id, haveSig.get(key)!); continue; }
    const id = crypto.randomUUID();
    sigId.set(g.id, id);
    if (key) haveSig.set(key, id);
    const now = new Date().toISOString();
    sigRows.push([
      id, sys, g.sigId, g.sigType, g.name, g.notes, g.whType, g.whLeadsTo, g.ghostType, g.massStatus, g.timeStatus,
      // Keeps its age: a wormhole signature's lifetime runs from when it was scanned.
      g.createdAt ?? now, g.updatedAt ?? g.createdAt ?? now, userId, true, g.scoutConnectionId,
    ]);
  }
  const signatures = await insertBatch(client, 'map_signatures',
    ['id', 'system_id', 'sig_id', 'sig_type', 'name', 'notes', 'wh_type', 'wh_leads_to', 'ghost_type', 'mass_status',
     'time_status', 'created_at', 'updated_at', 'created_by_user_id', 'from_merge', 'scout_connection_id'],
    sigRows, `ON CONFLICT (system_id, UPPER(sig_id)) WHERE sig_id <> '' DO NOTHING`);

  // Links: one per pair of systems, so a pair the map already joins is skipped.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const connRes = await client.query<{ a: string; b: string }>(
    `SELECT source_id AS a, target_id AS b FROM map_connections WHERE map_id = $1`, [mapId]);
  const seenPair = new Set(connRes.rows.map((c) => pairKey(c.a, c.b)));
  const linked = (id: string | null) => (id ? sigId.get(id) ?? null : null);
  const connRows: unknown[][] = [];
  for (const c of clip.connections) {
    const src = sysId.get(c.sourceId);
    const tgt = sysId.get(c.targetId);
    if (!src || !tgt || src === tgt) continue;
    const pair = pairKey(src, tgt);
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

  // Anomalies by id, structures by EVE id or name: only the missing ones.
  const anomRes = await client.query<{ systemId: string; anomId: string }>(
    `SELECT system_id AS "systemId", anom_id AS "anomId" FROM map_anomalies
      WHERE system_id = ANY($1::uuid[]) AND anom_id <> ''`, [targetIds]);
  const haveAnom = new Set(anomRes.rows.map((a) => `${a.systemId}|${a.anomId.toUpperCase()}`));
  const anomalies = await insertBatch(client, 'map_anomalies',
    ['system_id', 'anom_id', 'anom_type', 'name', 'notes', 'created_by_user_id', 'created_at', 'updated_at'],
    clip.anomalies.flatMap((a) => {
      const sys = sysId.get(a.systemId);
      if (!sys) return [];
      const key = a.anomId ? `${sys}|${a.anomId.toUpperCase()}` : null;
      if (key && haveAnom.has(key)) return [];
      if (key) haveAnom.add(key);
      const at = a.createdAt ?? new Date().toISOString();
      return [[sys, a.anomId, a.anomType, a.name, a.notes, userId, at, a.updatedAt ?? at]];
    }));

  const stRes = await client.query<{ systemId: string; name: string; eveId: string | null }>(
    `SELECT system_id AS "systemId", name, eve_id::text AS "eveId" FROM map_structures
      WHERE system_id = ANY($1::uuid[])`, [targetIds]);
  const haveSt = new Set<string>();
  for (const t of stRes.rows) {
    if (t.eveId) haveSt.add(`${t.systemId}|e${t.eveId}`);
    const n = (t.name ?? '').trim().toLowerCase();
    if (n) haveSt.add(`${t.systemId}|n${n}`);
  }
  const structures = await insertBatch(client, 'map_structures',
    ['system_id', 'name', 'structure_type', 'owner_corp', 'eve_id', 'notes', 'created_by_user_id', 'owner_corp_id'],
    clip.structures.flatMap((t) => {
      const sys = sysId.get(t.systemId);
      if (!sys) return [];
      const keys = [t.eveId ? `${sys}|e${t.eveId}` : '', `${sys}|n${t.name.trim().toLowerCase()}`].filter((k) => k && !k.endsWith('|n'));
      if (keys.some((k) => haveSt.has(k))) return [];
      for (const k of keys) haveSt.add(k);
      return [[sys, t.name, t.structureType, t.ownerCorp, t.eveId, t.notes, userId, t.ownerCorpId]];
    }));

  const focus = fresh.length
    ? { x: fresh.reduce((n, f) => n + f.x, 0) / fresh.length, y: fresh.reduce((n, f) => n + f.y, 0) / fresh.length }
    : matched.length ? { x: matched[0].dx, y: matched[0].dy } : null;

  return { systems, connections, signatures, anomalies, structures, matched: matched.length, focus };
}
