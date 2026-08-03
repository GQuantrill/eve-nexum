import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useUserSetting } from './useUserSetting';
import { useJumpRangeStore, type InRangeInfo } from '../store/jumpRangeStore';
import { classesInRange, maxRangeLy } from '../data/jumpDrives';

export interface JumpTarget {
  eveSystemId: number;
  name:        string;
  systemClass: string;      // 'LS' | 'NS'
  security:    number;
  regionName:  string | null;
  ly:          number;
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

  // Annotate + push the reachable set to the store (recomputed when jdc changes,
  // without re-fetching — the fetch radius already covers the widest class).
  const targets = useMemo(() => rows.filter((r) => r.ly <= maxLy), [rows, maxLy]);
  useEffect(() => {
    const m = new Map<number, InRangeInfo>();
    for (const t of targets) {
      const classes = classesInRange(t.ly, jdc);
      if (classes.length === 0) continue;
      m.set(t.eveSystemId, { ly: t.ly, color: classes[0].color, classKeys: classes.map((c) => c.key) });
    }
    setInRange(m);
  }, [targets, jdc, setInRange]);

  return { targets, loading, jdc, hasCoords };
}
