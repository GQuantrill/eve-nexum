import { api } from '../api/client';
import { toast } from '../components/ui/Toaster';
import { reevaluateConnectionsForSystem } from '../utils/whAutoDetect';
import i18n from '../i18n';
import type { Signature } from '../types';

// After a tracked wormhole jump, record which wormhole signature in the source
// system was jumped — pinning its leads-to to the SPECIFIC arrival system. A
// single plausible hole is filled directly (with an undo); ambiguous cases ask.
// See wh_jump_confirm_feature.md.

// The leads-to values that are class/band/unknown rather than a pinned system
// (see LeadsToDropdown). Anything NOT in here is a specific connected-system
// name — i.e. the hole is already solved, so we leave it alone.
const CLASS_OR_UNKNOWN = new Set([
  '', 'unknown',
  'C1-C3', 'C4-C5', 'C6', 'C13', 'Thera', 'Pochven', 'Drifter',
  'HS', 'LS', 'NS',
  'C1', 'C2', 'C3', 'C4', 'C5', // legacy exact-class values
]);

// The band value the dropdown uses for an exact C-space class.
function bandFor(cls: string): string {
  if (cls === 'C1' || cls === 'C2' || cls === 'C3') return 'C1-C3';
  if (cls === 'C4' || cls === 'C5') return 'C4-C5';
  return cls; // C6 / C13 / Thera / Pochven / Drifter / HS / LS / NS
}

// A hole is a plausible candidate when it isn't already pinned to a system, and
// its class/band is compatible with where we arrived ("unknown" always is; a
// hole that leads to a different class can't be the one we jumped).
function isCandidate(whLeadsTo: string, arrivalClass: string): boolean {
  const v = (whLeadsTo || '').trim();
  if (!CLASS_OR_UNKNOWN.has(v)) return false;          // already a specific system
  if (v === '' || v === 'unknown') return true;        // unknown → plausible
  return v === bandFor(arrivalClass) || v === arrivalClass;
}

export interface WhJumpContext {
  mapId:           string;
  fromMapSystemId: string;       // source system's map-node id (where the hole sig lives)
  fromEveSystemId: number | null;
  toEveSystemId:   number | null;
  toClass:         string;        // arrival system's class, e.g. 'C3'
  toName:          string;        // arrival system's name, e.g. 'J203753' — what we pin the hole to
}

export async function maybeConfirmWhJump(ctx: WhJumpContext): Promise<void> {
  const { mapId, fromMapSystemId, fromEveSystemId, toEveSystemId, toClass, toName } = ctx;

  // Wormhole jump only. Use the stargate route: directly gate-adjacent systems
  // are exactly 1 jump apart, so a shortest route of 1 means it was a gate, not
  // a hole. Anything > 1 jump — or no gate path at all, which includes ALL
  // w-space (no stargates) — means a wormhole. Race-free vs reading the
  // connection's async gate classification.
  if (fromEveSystemId && toEveSystemId) {
    try {
      const r = await api<Record<string, { jumps: number }>>(
        `/api/route?from=${fromEveSystemId}&to=${toEveSystemId}&mode=shortest`,
      );
      if (r[String(toEveSystemId)]?.jumps === 1) return; // adjacent → gate jump
    } catch { /* route unavailable — fall through and treat as a wormhole */ }
  }

  let sigs: Signature[];
  try {
    sigs = await api<Signature[]>(`/api/maps/${mapId}/systems/${fromMapSystemId}/signatures`);
  } catch {
    return;
  }

  // Eligible = known wormhole sigs not yet pinned to a system, whose class is
  // compatible with where we arrived. Unknowns (non-wormhole) are never touched.
  const candidates = sigs.filter((s) => s.sigType === 'wormhole' && isCandidate(s.whLeadsTo, toClass));
  if (candidates.length === 0) return;

  const t = i18n.t.bind(i18n);
  const label = (s: Signature): string => s.sigId || s.whType || s.name || '???';
  const dedupeKey = `whjump:${fromMapSystemId}->${toEveSystemId ?? '?'}`;

  // Write a hole's leads-to and re-run the same connection auto-detect the sig
  // pane uses on edit, so the map edge picks up the WH type. `oldSig` is the
  // pre-write state — it lets the auto-detect follow/clear the right link.
  const writeLeadsTo = (s: Signature, value: string, oldSig: Signature): void => {
    api(`/api/maps/${mapId}/systems/${fromMapSystemId}/signatures/${s.id}`, {
      method: 'PATCH',
      body:   JSON.stringify({ whLeadsTo: value }),
    }).catch(() => { /* best-effort; the user can still set it by hand */ });
    const updated = sigs.map((x) => (x.id === s.id ? { ...x, whLeadsTo: value } : x));
    reevaluateConnectionsForSystem(fromMapSystemId, updated, oldSig);
  };

  // One plausible hole → fill it directly (no prompt), with an undo. Several →
  // ask which one (no safe way to guess).
  if (candidates.length === 1) {
    const sole = candidates[0];
    const prev = sole.whLeadsTo;
    writeLeadsTo(sole, toName, sole);
    toast.show(t('whJump.filled', { sig: label(sole), system: toName }), {
      kind: 'success', dedupeKey, ttlMs: 8000,
      actions: [
        { label: t('whJump.undo'), onClick: () => writeLeadsTo(sole, prev, { ...sole, whLeadsTo: toName }) },
      ],
    });
    return;
  }

  toast.show(t('whJump.confirmMany', { system: toName }), {
    kind: 'info', sticky: true, dedupeKey,
    actions: [
      ...candidates.map((s) => ({ label: label(s), onClick: () => writeLeadsTo(s, toName, s) })),
      { label: t('whJump.unmapped'), onClick: () => { /* skip */ } },
    ],
  });
}
