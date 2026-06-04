import { useEffect } from 'react';
import { api } from '../api/client';
import { useMapStore } from '../store/mapStore';
import { useShareMode } from '../context/ShareModeContext';

interface SigTypeRow { systemId: string; whType: string }

/**
 * Mounted once (in MapCanvas). Keeps the store's map-wide signature-type index
 * fresh so the watchlist can match scanned wormhole sigs anywhere in the chain.
 * Bulk-fetches on map switch and re-fetches whenever any system's sigs change
 * remotely (sigRev ticks). The open sig pane pushes its own edits directly into
 * the index, so the user's own scans reflect instantly without a round-trip.
 */
export function useMapSignatureIndex() {
  const activeMapId = useMapStore((s) => s.activeMapId);
  const setSigTypesBulk = useMapStore((s) => s.setSigTypesBulk);
  const { isShareMode } = useShareMode();
  // Sum of all per-system sig revisions — bumps when any remote sig change
  // arrives, so we re-pull the index. Cheap; the map's system set is small.
  const sigRevTotal = useMapStore((s) => {
    let n = 0;
    for (const k in s.sigRev) n += s.sigRev[k];
    return n;
  });

  useEffect(() => {
    if (!activeMapId || isShareMode) { setSigTypesBulk({}); return; }
    let cancelled = false;
    api<SigTypeRow[]>(`/api/maps/${activeMapId}/signatures`)
      .then((rows) => {
        if (cancelled) return;
        const bySystem: Record<string, string[]> = {};
        for (const r of rows) {
          if (!r.whType) continue;
          (bySystem[r.systemId] ??= []).push(r.whType.toUpperCase());
        }
        setSigTypesBulk(bySystem);
      })
      .catch(() => { /* non-fatal — watchlist just won't match unopened sigs */ });
    return () => { cancelled = true; };
  }, [activeMapId, isShareMode, sigRevTotal, setSigTypesBulk]);
}
