import { useEffect } from 'react';
import { api } from '../api/client';
import { useMapStore } from '../store/mapStore';
import type { SystemContent } from '../store/mapStore';
import type { WhSig } from '../utils/undivedWormholes';
import { useShareMode } from '../context/ShareModeContext';

interface SigRow { id: string; sigId: string; systemId: string; sigType: string; name: string; whType: string; whLeadsTo: string }
interface AnomRow { systemId: string; anomType: string; name: string }

function uniqPush(arr: string[], v: string) {
  if (v && !arr.includes(v)) arr.push(v);
}

/**
 * Mounted once (in MapCanvas). Keeps two map-wide indexes fresh without opening
 * every system's pane:
 *  - sigTypesBySystem: the scanned wormhole-type codes per system (watchlist).
 *  - contentBySystem:  the sig types, anomaly types and site names per system,
 *    powering the content filter.
 * Bulk-fetches on map switch and re-fetches whenever any system's sigs/anoms
 * change remotely (sigRev/anomRev tick). The open sig pane also pushes its own
 * edits straight into sigTypesBySystem so the user's scans reflect instantly.
 */
export function useMapSignatureIndex() {
  const activeMapId = useMapStore((s) => s.activeMapId);
  const setSigTypesBulk = useMapStore((s) => s.setSigTypesBulk);
  const setContentBulk = useMapStore((s) => s.setContentBulk);
  const setWhSigsBulk = useMapStore((s) => s.setWhSigsBulk);
  const { isShareMode } = useShareMode();
  // Sum of all per-system sig + anom revisions — bumps when any remote change
  // arrives, so we re-pull. Cheap; the map's system set is small.
  const rev = useMapStore((s) => {
    let n = 0;
    for (const k in s.sigRev) n += s.sigRev[k];
    for (const k in s.anomRev) n += s.anomRev[k];
    return n;
  });

  useEffect(() => {
    if (!activeMapId || isShareMode) { setSigTypesBulk({}); setContentBulk({}); setWhSigsBulk({}); return; }
    let cancelled = false;
    Promise.all([
      api<SigRow[]>(`/api/maps/${activeMapId}/signatures`).catch(() => [] as SigRow[]),
      api<AnomRow[]>(`/api/maps/${activeMapId}/anomalies`).catch(() => [] as AnomRow[]),
    ])
      .then(([sigs, anoms]) => {
        if (cancelled) return;
        const whBySystem: Record<string, string[]> = {};
        const whSigs: Record<string, WhSig[]> = {};
        const content: Record<string, SystemContent> = {};
        const ensure = (id: string): SystemContent => (content[id] ??= { sigTypes: [], anomTypes: [], names: [] });

        for (const r of sigs) {
          if (r.whType) (whBySystem[r.systemId] ??= []).push(r.whType.toUpperCase());
          if (r.sigType === 'wormhole') {
            (whSigs[r.systemId] ??= []).push({
              id: r.id, sigId: r.sigId ?? '', whType: r.whType ?? '', leadsTo: r.whLeadsTo ?? '',
            });
          }
          const c = ensure(r.systemId);
          uniqPush(c.sigTypes, r.sigType);
          if (r.name) uniqPush(c.names, r.name.toLowerCase());
        }
        for (const r of anoms) {
          const c = ensure(r.systemId);
          uniqPush(c.anomTypes, r.anomType);
          if (r.name) uniqPush(c.names, r.name.toLowerCase());
        }
        setSigTypesBulk(whBySystem);
        setContentBulk(content);
        setWhSigsBulk(whSigs);
      })
      .catch(() => { /* non-fatal — filter/watchlist just won't see unopened content */ });
    return () => { cancelled = true; };
  }, [activeMapId, isShareMode, rev, setSigTypesBulk, setContentBulk, setWhSigsBulk]);
}
