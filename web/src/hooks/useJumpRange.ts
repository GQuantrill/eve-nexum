import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useUserSetting } from './useUserSetting';
import { useJumpRangeStore, type InRangeInfo } from '../store/jumpRangeStore';
import { useMapStore } from '../store/mapStore';
import { classesInRange, maxRangeLy } from '../data/jumpDrives';

export interface JumpTarget {
  eveSystemId: number;
  name:        string;
  systemClass: string;      // 'LS' | 'NS'
  security:    number;
  regionName:  string | null;
  ly:          number;
}

// Light-year distance between two systems, cached per unordered pair (distance is
// symmetric + static). `enabled` gates the fetch so non-cyno edges never call out.
const distanceCache = new Map<string, number | null>();
export function useJumpDistance(from: number | null, to: number | null, enabled: boolean): number | null {
  const key = from != null && to != null ? [from, to].sort((x, y) => x - y).join('-') : null;
  const [ly, setLy] = useState<number | null>(key && distanceCache.has(key) ? distanceCache.get(key)! : null);
  useEffect(() => {
    if (!enabled || key == null || from == null || to == null) return;
    if (distanceCache.has(key)) { setLy(distanceCache.get(key)!); return; }
    let cancelled = false;
    api<{ ly: number | null }>(`/api/systems/${from}/distance?to=${to}`)
      .then((d) => { distanceCache.set(key, d.ly); if (!cancelled) setLy(d.ly); })
      .catch(() => { /* leave null */ });
    return () => { cancelled = true; };
  }, [enabled, key, from, to]);
  return ly;
}

/** Jump Drive Calibration skill level (0-5). Per-user, syncs across devices. */
export function useJdcLevel(): [number, (n: number) => void] {
  const [jdc, setJdc] = useUserSetting<number>('nexum.jump.jdc', 5);
  const clamped = Number.isFinite(jdc) ? Math.max(0, Math.min(5, Math.round(jdc))) : 5;
  return [clamped, (n: number) => setJdc(Math.max(0, Math.min(5, Math.round(n))))];
}

/**
 * Fetches every LS/NS system within jump range of the store's staging system,
 * annotates each with the ship classes that can reach it (at the user's JDC), and
 * pushes the reachable set into the store so map nodes can highlight. Returns the
 * ordered target list for the panel. No staging → empty + store cleared.
 */
export function useJumpRange(): { targets: JumpTarget[]; loading: boolean; jdc: number; hasCoords: boolean } {
  const [jdc] = useJdcLevel();
  const stagingId = useJumpRangeStore((s) => s.stagingId);
  const setInRange = useJumpRangeStore((s) => s.setInRange);
  const [rows, setRows] = useState<JumpTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasCoords, setHasCoords] = useState(true);
  const maxLy = maxRangeLy(jdc);

  useEffect(() => {
    if (stagingId == null) { setRows([]); setHasCoords(true); setInRange(new Map()); return; }
    let cancelled = false;
    setLoading(true);
    api<{ hasCoords: boolean; systems: JumpTarget[] }>(`/api/systems/${stagingId}/jump-range?maxLy=${maxLy.toFixed(2)}`)
      .then((data) => { if (!cancelled) { setRows(data.systems); setHasCoords(data.hasCoords); } })
      .catch(() => { if (!cancelled) { setRows([]); setHasCoords(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [stagingId, maxLy, setInRange]);

  // Scope to systems ON THE CURRENT MAP — the endpoint returns every LS/NS system
  // in range (all of New Eden), but the overlay only highlights placed systems, so
  // the panel must match. (Full off-map reachability is a future jump planner.)
  const mapSystems = useMapStore((s) => s.map.systems);
  const targets = useMemo(() => {
    const onMap = new Set(mapSystems.map((s) => s.eveSystemId).filter((id): id is number => id != null));
    return rows.filter((r) => r.ly <= maxLy && onMap.has(r.eveSystemId));
  }, [rows, maxLy, mapSystems]);
  useEffect(() => {
    const m = new Map<number, InRangeInfo>();
    for (const t of targets) {
      const classes = classesInRange(t.ly, jdc);
      if (classes.length === 0) continue;
      // Colour by the TIGHTEST class that still reaches (last in the widest-first
      // list) — a distance gradient (close = super/orange … far = JF/blue) rather
      // than every reachable system sharing the widest class's colour.
      m.set(t.eveSystemId, { ly: t.ly, color: classes[classes.length - 1].color, classKeys: classes.map((c) => c.key) });
    }
    setInRange(m);
  }, [targets, jdc, setInRange]);

  return { targets, loading, jdc, hasCoords };
}
