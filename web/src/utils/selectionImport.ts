// Import systems from CSV or tab-separated rows, the same columns Export
// systems writes (selectionExport.ts): group, system, signature, sig-type,
// name, to-system, from-type, to-type, size, mass-remaining, life-remaining.
// Every row is checked first; the good ones become a clip (mapClipboard.ts)
// and go through the same paste the map uses, so placement and permissions
// work the same way.
//
// What "group" means is the pilot's choice: the map (just a note, nothing is
// done with it), a saved chain (the group's systems saved as a chain, when
// they form a path), or a label (a custom text label on the group's systems).

import type { ClipChain } from './mapClipboard';

export type GroupMeaning = 'map' | 'chain' | 'label';
export const GROUP_MEANINGS: GroupMeaning[] = ['map', 'chain', 'label'];
export const GROUP_MEANING_KEY = 'nexum.systems.groupMeaning';

export type RowError =
  | 'noSystem' | 'unknownSystem' | 'badSignature' | 'badSigType' | 'whOnly' | 'unknownToSystem'
  | 'sameSystem' | 'badType' | 'bothK162' | 'badSize' | 'sizeMismatch' | 'badMass' | 'badLife';

export type SizeClass = 'xl' | 'large' | 'medium' | 'small';
type Mass = 'stable' | 'destabilized' | 'critical';
type Life = 'fresh' | 'lessThan24h' | 'lessThan4h' | 'lessThan1h' | 'expired';

export interface CheckedRow {
  line: number;
  group: string;
  system: string;
  signature: string;
  sigType: string;
  name: string;
  toSystem: string;
  fromType: string;
  toType: string;
  size: SizeClass | '';
  mass: Mass;
  life: Life;
  /** Hours of life left when the file gave it, for the hole's clock. */
  lifeHours: number | null;
  errors: RowError[];
}

export interface KnownSystem { eveSystemId: number; name: string }
export interface WhSpec { maxJumpMass?: number; lifetimeHours?: number }

// ── Reading the table ────────────────────────────────────────────────────────

/** Split delimited text into rows of cells (RFC 4180 quoting). */
export function splitTable(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const COLUMNS = ['group', 'system', 'signature', 'sig-type', 'name', 'to-system', 'from-type', 'to-type',
  'size', 'mass-remaining', 'life-remaining'] as const;
type Column = (typeof COLUMNS)[number];
const ALIASES: Record<string, Column> = { mass: 'mass-remaining', life: 'life-remaining', type: 'sig-type', sig: 'signature' };

export interface RawRow { line: number; cells: Record<Column, string> }

/**
 * The rows of a CSV or tab-separated table with a header line. Tab wins if the
 * header has one, then semicolon (a European spreadsheet's CSV), else comma.
 * Null if there is no "system" column.
 */
export function readTable(text: string): RawRow[] | null {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const table = splitTable(text.replace(/^\uFEFF/, ''), sep);
  if (!table.length) return null;
  const head = table[0].map((h) => {
    const k = h.trim().toLowerCase().replace(/[\s_]+/g, '-');
    return (COLUMNS as readonly string[]).includes(k) ? (k as Column) : ALIASES[k] ?? null;
  });
  if (!head.includes('system')) return null;
  return table.slice(1).map((cells, i) => {
    const out = Object.fromEntries(COLUMNS.map((c) => [c, ''])) as Record<Column, string>;
    head.forEach((c, j) => { if (c) out[c] = (cells[j] ?? '').trim(); });
    return { line: i + 2, cells: out };
  });
}

// ── Checking the rows ────────────────────────────────────────────────────────

const SIG_TYPES = new Set(['wormhole', 'data', 'relic', 'combat', 'gas', 'ore', 'ghost', 'unknown']);
const SIZES: Record<string, SizeClass> = {
  s: 'small', small: 'small', frigate: 'small',
  m: 'medium', medium: 'medium', cruiser: 'medium',
  l: 'large', large: 'large', battleship: 'large',
  xl: 'xl', 'x-large': 'xl', capital: 'xl', freighter: 'xl',
};
const MASS: Record<string, Mass> = {
  '100': 'stable', '>50': 'stable', '>50%': 'stable', stable: 'stable',
  '50': 'destabilized', '<50': 'destabilized', '<50%': 'destabilized', destabilized: 'destabilized',
  '10': 'critical', '<10': 'critical', '<10%': 'critical', critical: 'critical',
};
const LIFE: Record<string, { life: Life; hours: number }> = {
  '48': { life: 'fresh', hours: 48 },
  '24': { life: 'lessThan24h', hours: 24 },
  '4': { life: 'lessThan4h', hours: 4 }, eol: { life: 'lessThan4h', hours: 4 },
  '1': { life: 'lessThan1h', hours: 1 },
  '0': { life: 'expired', hours: 0 },
};

function sizeOf(maxJumpMass: number | undefined): SizeClass | null {
  if (!maxJumpMass) return null;
  if (maxJumpMass >= 1_000_000_000) return 'xl';
  if (maxJumpMass >= 300_000_000) return 'large';
  if (maxJumpMass >= 62_000_000) return 'medium';
  return 'small';
}

const SIG_RE = /^([A-Z]{3})-?(\d{3})?$/;

export function checkRows(
  rows: RawRow[], known: Map<string, KnownSystem>, whTypes: Record<string, WhSpec>,
): CheckedRow[] {
  const isType = (t: string) => t === 'K162' || (Object.keys(whTypes).length ? !!whTypes[t] : /^[A-Z]\d{3}$/.test(t));
  return rows.map(({ line, cells: c }) => {
    const errors: RowError[] = [];
    const sys = known.get(c.system.toLowerCase());
    if (!c.system) errors.push('noSystem');
    else if (!sys) errors.push('unknownSystem');

    let signature = c.signature.toUpperCase().replace(/\s+/g, '');
    if (signature) {
      const m = SIG_RE.exec(signature);
      if (!m) errors.push('badSignature');
      else signature = m[2] ? `${m[1]}-${m[2]}` : m[1];
    }

    const holeFields = !!(c['to-system'] || c['from-type'] || c['to-type'] || c.size || c['mass-remaining'] || c['life-remaining']);
    let sigType = c['sig-type'].toLowerCase();
    if (sigType === 'wh') sigType = 'wormhole';
    if (!sigType) sigType = holeFields ? 'wormhole' : signature ? 'unknown' : '';
    if (sigType && !SIG_TYPES.has(sigType)) errors.push('badSigType');
    const wh = sigType === 'wormhole';
    if (!wh && holeFields) errors.push('whOnly');

    const out: CheckedRow = {
      line, group: c.group.slice(0, 40), system: sys?.name ?? c.system, signature, sigType, name: c.name.slice(0, 200),
      toSystem: '', fromType: '', toType: '', size: '', mass: 'stable', life: 'fresh', lifeHours: null, errors,
    };
    if (!wh) return out;

    if (c['to-system']) {
      const to = known.get(c['to-system'].toLowerCase());
      if (!to) errors.push('unknownToSystem');
      else if (sys && to.eveSystemId === sys.eveSystemId) errors.push('sameSystem');
      else out.toSystem = to.name;
    }

    // Blank on one side is a K162 when the other side is a real type; both
    // blank is a hole whose type isn't known yet.
    let from = c['from-type'].toUpperCase();
    let to = c['to-type'].toUpperCase();
    if (from && !isType(from)) errors.push('badType');
    if (to && !isType(to)) errors.push('badType');
    if (from === 'K162' && to === 'K162') errors.push('bothK162');
    if (!from && to && to !== 'K162') from = 'K162';
    if (!to && from && from !== 'K162') to = 'K162';
    out.fromType = from; out.toType = to;
    const real = from && from !== 'K162' ? from : to && to !== 'K162' ? to : '';

    if (c.size) {
      const size = SIZES[c.size.toLowerCase()];
      if (!size) errors.push('badSize');
      else {
        const fits = real ? sizeOf(whTypes[real]?.maxJumpMass) : null;
        if (fits && fits !== size) errors.push('sizeMismatch');
        out.size = size;
      }
    } else if (real) out.size = sizeOf(whTypes[real]?.maxJumpMass) ?? '';

    if (c['mass-remaining']) {
      const m = MASS[c['mass-remaining'].toLowerCase().replace(/\s+/g, '')];
      if (!m) errors.push('badMass'); else out.mass = m;
    }

    const max = real ? whTypes[real]?.lifetimeHours : undefined;
    if (c['life-remaining']) {
      const l = LIFE[c['life-remaining'].toLowerCase().replace(/h$/, '')];
      if (!l) errors.push('badLife');
      else {
        // Never more than the type can have: a "48" on a 16h hole is under a day.
        const h = max ? Math.min(l.hours, max) : l.hours;
        out.lifeHours = h;
        out.life = h <= 0 ? 'expired' : h <= 1 ? 'lessThan1h' : h <= 4 ? 'lessThan4h' : h <= 24 ? 'lessThan24h' : 'fresh';
      }
    } else if (max && max <= 24) out.life = 'lessThan24h';
    return out;
  });
}

// ── Turning good rows into a paste ───────────────────────────────────────────

export interface ImportPlan {
  clip: Record<string, unknown>;
  chains: ClipChain[];
  mergeLabels: boolean;
  /** Groups that can't be saved as a chain: their systems aren't one path. */
  notPaths: string[];
}

const COL_W = 280, ROW_H = 160;

export function planImport(
  rows: CheckedRow[], known: Map<string, KnownSystem>, meaning: GroupMeaning, now = Date.now(),
): ImportPlan {
  const good = rows.filter((r) => r.errors.length === 0);
  const idOf = (name: string) => `s${known.get(name.toLowerCase())!.eveSystemId}`;

  // Systems, with the groups they belong to.
  const systems = new Map<string, { id: string; eveSystemId: number; name: string; groups: Set<string> }>();
  const addSystem = (name: string, group: string) => {
    const k = known.get(name.toLowerCase())!;
    const id = `s${k.eveSystemId}`;
    if (!systems.has(id)) systems.set(id, { id, eveSystemId: k.eveSystemId, name: k.name, groups: new Set() });
    if (group) systems.get(id)!.groups.add(group);
  };

  const signatures: Record<string, unknown>[] = [];
  const seenSig = new Set<string>();
  const conns = new Map<string, Record<string, unknown> & { sourceId: string; targetId: string }>();
  const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const edges = new Map<string, Set<string>>();     // group -> pair keys

  for (const r of good) {
    addSystem(r.system, r.group);
    const here = idOf(r.system);
    let sigId: string | null = null;
    const sigKey = `${here}|${r.signature}`;
    if (r.signature && !seenSig.has(sigKey)) {
      seenSig.add(sigKey);
      sigId = `g${r.line}`;
      signatures.push({
        id: sigId, systemId: here, sigId: r.signature, sigType: r.sigType, name: r.name, whType: r.fromType,
        massStatus: r.sigType === 'wormhole' ? r.mass : '', timeStatus: r.sigType === 'wormhole' ? r.life : '',
      });
    }
    if (!r.toSystem) continue;
    addSystem(r.toSystem, r.group);
    const there = idOf(r.toSystem);
    const key = pair(here, there);
    const type = r.fromType && r.fromType !== 'K162' ? r.fromType : r.toType || r.fromType || null;
    const existing = conns.get(key);
    if (existing) {
      // The other end's row: its signature backs the same hole.
      if (sigId && existing.targetId === here && !existing.targetSignatureId) existing.targetSignatureId = sigId;
      else if (sigId && existing.sourceId === here && !existing.sourceSignatureId) existing.sourceSignatureId = sigId;
    } else {
      conns.set(key, {
        sourceId: here, targetId: there, type, size: r.size || 'large', massStatus: r.mass, timeStatus: r.life,
        lifetimeExpiresAt: r.lifeHours ? new Date(now + r.lifeHours * 3_600_000).toISOString() : null,
        sourceSignatureId: sigId, targetSignatureId: null,
      });
    }
    if (r.group) {
      if (!edges.has(r.group)) edges.set(r.group, new Set());
      edges.get(r.group)!.add(key);
    }
  }

  // A rough layout: each linked group of systems fans out in columns from
  // its first system; the paste then lines it up on the map.
  const adj = new Map<string, string[]>();
  for (const c of conns.values()) {
    adj.set(c.sourceId, [...(adj.get(c.sourceId) ?? []), c.targetId]);
    adj.set(c.targetId, [...(adj.get(c.targetId) ?? []), c.sourceId]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let top = 0;
  for (const start of systems.keys()) {
    if (pos.has(start)) continue;
    const depthRows = new Map<number, number>();
    const queue: [string, number][] = [[start, 0]];
    pos.set(start, { x: 0, y: top });
    depthRows.set(0, 1);
    let deepest = 1;
    while (queue.length) {
      const [id, d] = queue.shift()!;
      for (const n of adj.get(id) ?? []) {
        if (pos.has(n)) continue;
        const row = depthRows.get(d + 1) ?? 0;
        depthRows.set(d + 1, row + 1);
        deepest = Math.max(deepest, row + 1);
        pos.set(n, { x: (d + 1) * COL_W, y: top + row * ROW_H });
        queue.push([n, d + 1]);
      }
    }
    top += deepest * ROW_H;
  }

  const clipSystems = [...systems.values()].map((s) => ({
    id: s.id, eveSystemId: s.eveSystemId, name: s.name, position: pos.get(s.id) ?? { x: 0, y: 0 },
    customLabels: meaning === 'label' ? [...s.groups].slice(0, 3).map((g) => `t:${g}`) : [],
  }));

  // Chains: a group whose links make one path, end to end.
  const chains: ClipChain[] = [];
  const notPaths: string[] = [];
  if (meaning === 'chain') {
    const groups = new Set(good.map((r) => r.group).filter(Boolean));
    for (const g of groups) {
      const keys = [...(edges.get(g) ?? [])];
      const nb = new Map<string, string[]>();
      for (const k of keys) {
        const [a, b] = k.split('|');
        nb.set(a, [...(nb.get(a) ?? []), b]);
        nb.set(b, [...(nb.get(b) ?? []), a]);
      }
      const ends = [...nb].filter(([, v]) => v.length === 1).map(([k]) => k);
      const isPath = keys.length > 0 && ends.length === 2 && [...nb.values()].every((v) => v.length <= 2);
      const order: string[] = [];
      if (isPath) {
        let prev = '', cur = ends[0];
        while (cur) {
          order.push(cur);
          const next = (nb.get(cur) ?? []).find((n) => n !== prev);
          prev = cur; cur = next ?? '';
          if (order.length > nb.size) break;
        }
      }
      if (isPath && order.length === nb.size) chains.push({ name: g, systemIds: order });
      else notPaths.push(g);
    }
  }

  return {
    clip: {
      format: 'nexum-systems', name: 'import', systems: clipSystems,
      connections: [...conns.values()], signatures, anomalies: [], structures: [],
    },
    chains,
    mergeLabels: meaning === 'label',
    notPaths,
  };
}
