import { useEffect, useMemo, useRef, useState } from 'react';
import { useCharacterLocation } from './useCharacterLocation';
import { useIncursions } from './useIncursions';
import { useInsurgency } from './useInsurgency';
import { useRoute } from './useRoute';
import { useStandings } from './useStandings';
import { ensureSovLoaded, getSovEntries } from './useSovData';

export type ThreatKind = 'incursion' | 'insurgency' | 'hostile-sov';

export interface NearestThreat {
  kind:        ThreatKind;
  jumps:       number;
  systemId:    number;
}

const THRESHOLD_KEY = 'nexum.proximityThreshold';
const DEFAULT_THRESHOLD = 2;

export function readThreshold(): number {
  const raw = localStorage.getItem(THRESHOLD_KEY);
  if (!raw) return DEFAULT_THRESHOLD;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 5) return DEFAULT_THRESHOLD;
  return n;
}

export function writeThreshold(n: number): void {
  localStorage.setItem(THRESHOLD_KEY, String(Math.max(0, Math.min(5, Math.floor(n)))));
}

/** Threshold-watching hook. Returns the current threshold and a setter. */
export function useProximityThreshold(): [number, (n: number) => void] {
  const [threshold, setThreshold] = useState<number>(() => readThreshold());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THRESHOLD_KEY) setThreshold(readThreshold());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return [
    threshold,
    (n: number) => { writeThreshold(n); setThreshold(readThreshold()); },
  ];
}

let audioCtx: AudioContext | null = null;
function playBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    o.type = 'sine';
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch { /* audio blocked / unavailable — silent fail */ }
}

function fireBrowserNotification(kind: ThreatKind, jumps: number, sysName: string) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  const title =
    kind === 'incursion'   ? 'Incursion nearby' :
    kind === 'insurgency'  ? 'Insurgency nearby' :
    kind === 'hostile-sov' ? 'Hostile sov nearby' :
    'Threat nearby';
  const body  = jumps === 0 ? `You are in ${sysName}` : `${jumps} jump${jumps === 1 ? '' : 's'} from ${sysName}`;
  try { new Notification(title, { body, tag: `nexum-${kind}-${sysName}` }); } catch { /* ignore */ }
}

/**
 * Watch the user's current location, the live incursion + insurgency lists,
 * and the route graph. Returns the nearest reachable threat (if any) plus the
 * configured threshold. When jump distance to the nearest threat crosses below
 * the threshold, fires a browser notification + audio beep once. No re-alerts
 * until the user moves back out of the threat zone.
 */
export function useProximityAlerts(): {
  nearest:   NearestThreat | null;
  threshold: number;
} {
  const location   = useCharacterLocation();
  const incursions = useIncursions();
  const insurgency = useInsurgency();
  const standings  = useStandings();
  const [threshold] = useProximityThreshold();

  // Cluster-wide sov data loads asynchronously the first time anyone
  // consumes it. We need to know when it's ready so we can fold the
  // hostile-sov systems into the target list. Re-runs only when standings
  // become available — sov data itself is immutable per session after
  // first fetch.
  const [sovReady, setSovReady] = useState(false);
  useEffect(() => {
    ensureSovLoaded().then(() => setSovReady(true));
  }, []);

  const { targetIds, kindMap, nameMap } = useMemo(() => {
    const ids = new Set<number>();
    const kinds = new Map<number, ThreatKind>();
    const names = new Map<number, string>();
    for (const i of incursions) {
      ids.add(i.systemId);
      kinds.set(i.systemId, 'incursion');
    }
    for (const i of insurgency) {
      // Insurgency may not collide with incursions; if it does, incursion wins.
      if (!ids.has(i.systemId)) {
        ids.add(i.systemId);
        kinds.set(i.systemId, 'insurgency');
      }
    }
    // Hostile-sov: any sov-holding system where the user has any negative
    // standing toward the corp OR alliance. We don't track standings here
    // — that's just stored contacts — so this set can be tiny depending
    // on the user's contact list. Incursion / insurgency win the tie so
    // the more time-bounded threats take priority on the chip.
    if (sovReady && standings.loaded) {
      for (const [sysId, entry] of getSovEntries()) {
        if (ids.has(sysId)) continue;
        const corpStanding     = entry.corporation_id ? standings.getStanding('corporation', entry.corporation_id).effective : 0;
        const allianceStanding = entry.alliance_id    ? standings.getStanding('alliance',    entry.alliance_id).effective    : 0;
        const worst = Math.min(corpStanding, allianceStanding);
        if (worst < 0) {
          ids.add(sysId);
          kinds.set(sysId, 'hostile-sov');
        }
      }
    }
    return { targetIds: [...ids], kindMap: kinds, nameMap: names };
  }, [incursions, insurgency, sovReady, standings]);

  const routes = useRoute(location.system?.eveSystemId ?? null, targetIds);

  const nearest = useMemo<NearestThreat | null>(() => {
    let best: NearestThreat | null = null;
    for (const [idStr, entry] of Object.entries(routes)) {
      const id    = Number(idStr);
      const kind  = kindMap.get(id);
      if (!kind) continue;
      if (!best || entry.jumps < best.jumps) {
        best = { kind, jumps: entry.jumps, systemId: id };
        // Capture name from the route path's last entry for the notification body
        const last = entry.path[entry.path.length - 1];
        if (last) nameMap.set(id, last.name);
      }
    }
    return best;
  }, [routes, kindMap, nameMap]);

  // Fire-once-on-entry tracker
  const inZoneRef = useRef(false);
  useEffect(() => {
    const inZone = !!nearest && nearest.jumps <= threshold;
    if (inZone && !inZoneRef.current && nearest) {
      const sysName = nameMap.get(nearest.systemId) ?? String(nearest.systemId);
      fireBrowserNotification(nearest.kind, nearest.jumps, sysName);
      playBeep();
      inZoneRef.current = true;
    } else if (!inZone) {
      inZoneRef.current = false;
    }
  }, [nearest, threshold, nameMap]);

  return { nearest, threshold };
}
