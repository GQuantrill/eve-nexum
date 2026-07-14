import { api } from '../api/client';
import { toast } from '../components/ui/Toaster';
import { reevaluateConnectionsForSystem } from '../utils/whAutoDetect';
import { isUnresolvedLeadsTo } from '../utils/whDest';
import { useMapStore, awaitConnectionType } from '../store/mapStore';
import i18n from '../i18n';
import type { Signature } from '../types';

// After a tracked wormhole jump, record which wormhole signature in the source
// system was jumped — pinning its leads-to to the SPECIFIC arrival system. A
// single plausible hole is filled directly (with an undo); ambiguous cases ask.
// See wh_jump_confirm_feature.md.

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
  if (!isUnresolvedLeadsTo(v)) return false;           // already a specific system
  if (v === '' || v.toLowerCase() === 'unknown') return true; // unknown → plausible
  return v.toUpperCase() === bandFor(arrivalClass).toUpperCase()
      || v.toUpperCase() === arrivalClass.toUpperCase();
}

export interface WhJumpContext {
  mapId:           string;
  fromMapSystemId: string;       // source system's map-node id (where the hole sig lives)
  toEveSystemId:   number | null;
  toClass:         string;        // arrival system's class, e.g. 'C3'
  toName:          string;        // arrival system's name, e.g. 'J203753' — what we pin the hole to
  connId:          string | null; // the connection the jump traversed
}

export async function maybeConfirmWhJump(ctx: WhJumpContext): Promise<void> {
  const { mapId, fromMapSystemId, toEveSystemId, toClass, toName, connId } = ctx;

  let sigs: Signature[];
  try {
    sigs = await api<Signature[]>(`/api/maps/${mapId}/systems/${fromMapSystemId}/signatures`);
  } catch {
    return;
  }

  // Already accounted for: a wormhole sig here is pinned to exactly where we
  // arrived, so this hole is solved and its connection's backing sig is (or will
  // be) linked by the sig auto-detect. Don't fill a second hole or prompt — this
  // is the "asked which sig on the way back even though one already leads home"
  // case.
  const arrived = toName.toUpperCase();
  if (sigs.some((s) => s.sigType === 'wormhole' && (s.whLeadsTo || '').toUpperCase() === arrived)) return;

  // Eligible = known wormhole sigs not yet pinned to a system, whose class is
  // compatible with where we arrived. Unknowns (non-wormhole) are never touched.
  // Bail before the gate check when there's nothing to fill.
  const candidates = sigs.filter((s) => s.sigType === 'wormhole' && isCandidate(s.whLeadsTo, toClass));
  if (candidates.length === 0) return;

  // Wormhole jump only. Use the connection's server gate classification — the
  // same map_stargates check that draws the 'G' badge, reliable now that gates
  // are classified from the endpoints' eve ids at create time. For a fresh
  // connection, await the create POST's result; an existing one is already
  // classified in the store. Proceed ONLY for a confirmed 'standard' (wormhole)
  // — a gate / jump-bridge / unknown is left alone, so no false fills on a gate.
  if (connId) {
    const pending = awaitConnectionType(connId);
    const ct = pending
      ? await pending
      : useMapStore.getState().map.connections.find((c) => c.id === connId)?.connectionType ?? 'standard';
    if (ct !== 'standard') return;
  }

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
