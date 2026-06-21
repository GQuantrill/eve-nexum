import { api } from '../api/client';
import { toast } from '../components/ui/Toaster';
import { reevaluateConnectionsForSystem } from '../utils/whAutoDetect';
import i18n from '../i18n';
import type { Signature } from '../types';

// After a tracked wormhole jump, offer to record which wormhole signature in
// the source system was the one jumped — upgrading its leads-to from a class /
// "unknown" to the SPECIFIC system we arrived in. Confirm-on-commit: nothing is
// written until the user picks, so no premature live-sync / Discord broadcast.
// See wh_jump_confirm_feature.md.

// W-space ids start here; w-space has no stargates, so a jump touching it is a
// wormhole jump. (k<->k wormhole jumps need server gate data — out of v1.)
const WSPACE_MIN_ID = 31_000_000;
const isWspace = (eveId: number | null): boolean => eveId !== null && eveId >= WSPACE_MIN_ID;

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

  // Only when the jump involves w-space (guaranteed-wormhole).
  if (!isWspace(fromEveSystemId) && !isWspace(toEveSystemId)) return;

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

  // Pin the hole to the specific arrival system (the dropdown stores the
  // connected-system name as the leads-to value), then re-run the same
  // connection auto-detect the sig pane uses on edit — so the map edge picks up
  // this sig's WH type now that the hole resolves to the destination system.
  const setLeadsTo = (s: Signature): void => {
    api(`/api/maps/${mapId}/systems/${fromMapSystemId}/signatures/${s.id}`, {
      method: 'PATCH',
      body:   JSON.stringify({ whLeadsTo: toName }),
    }).catch(() => { /* best-effort; the user can still set it by hand */ });
    const updated = sigs.map((x) => (x.id === s.id ? { ...x, whLeadsTo: toName } : x));
    reevaluateConnectionsForSystem(fromMapSystemId, updated, s);
  };

  // One plausible hole → one-tap confirm; several → one button per candidate.
  if (candidates.length === 1) {
    const sole = candidates[0];
    toast.show(t('whJump.confirmOne', { sig: label(sole), system: toName }), {
      kind: 'info', sticky: true, dedupeKey,
      actions: [
        { label: t('whJump.confirm'),       primary: true, onClick: () => setLeadsTo(sole) },
        { label: t('whJump.differentHole'),                onClick: () => { /* skip */ } },
      ],
    });
    return;
  }

  toast.show(t('whJump.confirmMany', { system: toName }), {
    kind: 'info', sticky: true, dedupeKey,
    actions: [
      ...candidates.map((s) => ({ label: label(s), onClick: () => setLeadsTo(s) })),
      { label: t('whJump.unmapped'), onClick: () => { /* skip */ } },
    ],
  });
}
