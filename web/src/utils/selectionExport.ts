// Export selected systems as rows for another mapper or a spreadsheet: one row
// per signature (a system with none still gets a row), wormhole details filled
// in from the link the signature backs. Built from the same clip that Copy
// systems uses (mapClipboard.ts), so it sees exactly what Copy would.

import type { GroupMeaning } from './selectionImport';

export interface ClipSystem { id: string; name: string; alias?: string | null; locked?: boolean; customLabels?: string[] }
export interface ClipSignature {
  id: string; systemId: string; sigId: string; sigType: string; name: string;
  whType: string; massStatus?: string; timeStatus?: string;
}
export interface ClipConnection {
  sourceId: string; targetId: string; size: string; massStatus: string | null; timeStatus: string | null;
  sourceSignatureId: string | null; targetSignatureId: string | null;
}
export interface Clip {
  name: string;
  systems: ClipSystem[];
  signatures: ClipSignature[];
  connections: ClipConnection[];
  chains?: { name: string; systemIds: string[] }[];
}

export const EXPORT_COLUMNS = [
  'group', 'system', 'signature', 'sig-type', 'name', 'to-system', 'from-type', 'to-type',
  'size', 'mass-remaining', 'life-remaining',
] as const;
export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], string>;

// Mass left, as the percentage bands EVE shows.
const MASS: Record<string, string> = { stable: '100', destabilized: '50', critical: '10' };
// Hours of life left, as the bands EVE shows.
const LIFE: Record<string, string> = {
  fresh: '48', lessThan24h: '24', eol: '4', lessThan4h: '4', lessThan1h: '1', expired: '0',
};

// The text of a custom label: 't:<text>' or 't:#rrggbb:<text>'; icons have none.
const labelText = (l: string) => (l.startsWith('t:') ? l.replace(/^t:(#[0-9a-fA-F]{6}:)?/, '') : '');

export function exportRows(clip: Clip, skipLocked: boolean, meaning: GroupMeaning = 'map'): ExportRow[] {
  // What goes in "group": the map's name, the saved chain the system is in,
  // or its first text label.
  const chainOf = new Map<string, string>();
  for (const c of clip.chains ?? []) for (const id of c.systemIds) if (!chainOf.has(id)) chainOf.set(id, c.name);
  const groupOf = (s: ClipSystem) => meaning === 'chain' ? chainOf.get(s.id) ?? ''
    : meaning === 'label' ? (s.customLabels ?? []).map(labelText).find(Boolean) ?? ''
      : clip.name;

  const systems = clip.systems.filter((s) => !(skipLocked && s.locked));
  const keep = new Set(systems.map((s) => s.id));
  const nameOf = new Map(clip.systems.map((s) => [s.id, s.name]));
  const sigById = new Map(clip.signatures.map((g) => [g.id, g]));
  // Signature id -> the link it backs, and which end it is on.
  const linkOf = new Map<string, { c: ClipConnection; other: string; otherSig: string | null }>();
  for (const c of clip.connections) {
    if (c.sourceSignatureId) linkOf.set(c.sourceSignatureId, { c, other: c.targetId, otherSig: c.targetSignatureId });
    if (c.targetSignatureId) linkOf.set(c.targetSignatureId, { c, other: c.sourceId, otherSig: c.sourceSignatureId });
  }

  const empty = (s: ClipSystem): ExportRow => ({
    group: groupOf(s), system: s.name, signature: '', 'sig-type': '', name: '', 'to-system': '', 'from-type': '',
    'to-type': '', size: '', 'mass-remaining': '', 'life-remaining': '',
  });

  const rows: ExportRow[] = [];
  for (const s of systems) {
    const sigs = clip.signatures.filter((g) => g.systemId === s.id && keep.has(g.systemId));
    if (sigs.length === 0) { rows.push(empty(s)); continue; }
    for (const g of sigs) {
      const row = { ...empty(s), signature: g.sigId, 'sig-type': g.sigType, name: g.name };
      if (g.sigType === 'wormhole') {
        const l = linkOf.get(g.id);
        const mass = l?.c.massStatus ?? g.massStatus ?? '';
        const life = l?.c.timeStatus ?? g.timeStatus ?? '';
        row['to-system'] = l ? nameOf.get(l.other) ?? '' : '';
        row['from-type'] = g.whType ?? '';
        row['to-type'] = l?.otherSig ? sigById.get(l.otherSig)?.whType ?? '' : '';
        row.size = l?.c.size ?? '';
        row['mass-remaining'] = MASS[mass] ?? '';
        row['life-remaining'] = LIFE[life] ?? '';
      }
      rows.push(row);
    }
  }
  return rows;
}

// A spreadsheet runs a cell starting with = + - @ as a formula, and signature
// names and notes are typed by other pilots. Such a cell gets a leading '.
const guard = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function toDelimited(rows: ExportRow[], sep: ',' | '\t'): string {
  const cell = (raw: string) => {
    const v = guard(raw);
    if (sep === '\t') return v.replace(/[\t\r\n]+/g, ' ');
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return [EXPORT_COLUMNS.join(sep), ...rows.map((r) => EXPORT_COLUMNS.map((c) => cell(r[c])).join(sep))].join('\r\n') + '\r\n';
}

export function toJson(rows: ExportRow[]): string {
  return JSON.stringify(rows, null, 2);
}
