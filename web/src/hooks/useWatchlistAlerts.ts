import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapStore } from '../store/mapStore';
import { useUserSetting } from './useUserSetting';
import { useWatchlist } from './useWatchlist';
import { matchSystem, matchConnection } from '../utils/watchMatch';
import { toast } from '../components/ui/Toaster';

// Lazily-created shared audio context (autoplay policy: only on first sound).
let audioCtx: AudioContext | null = null;
function playWatchChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    // 988Hz triangle — distinct from the K162 (1320 sawtooth) and proximity
    // (880 sine) alerts so the ear can tell the three apart.
    o.frequency.value = 988;
    o.type = 'triangle';
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.34);
  } catch { /* audio blocked / unavailable — silent fail */ }
}

/**
 * Mounted once (in MapCanvas). Watches the active map's systems AND connections
 * against the watchlist and fires a one-shot toast + chime the first time a
 * watched thing *appears*. Match targets are keyed by id (system id / connection
 * id) so a match is alerted once. On a map switch — or whenever the watchlist
 * entries themselves change (e.g. you tick a characteristic) — the present
 * matches are seeded silently, so neither loading a map nor editing the list
 * barrages you; only genuine new appearances chime. A target that leaves
 * re-arms.
 */
export function useWatchlistAlerts() {
  const { t } = useTranslation();
  const systems     = useMapStore((s) => s.map.systems);
  const connections = useMapStore((s) => s.map.connections);
  const activeMapId = useMapStore((s) => s.activeMapId);
  const [entries]   = useWatchlist();
  const [soundOn]   = useUserSetting<boolean>('nexum.watchlist.sound', true);

  const stateRef = useRef<{ mapId: string | null; entries: unknown; alerted: Set<string> }>({
    mapId: null, entries: null, alerted: new Set(),
  });

  useEffect(() => {
    if (entries.length === 0) {
      stateRef.current = { mapId: activeMapId, entries, alerted: new Set() };
      return;
    }

    // Present matches, keyed by target id, with the label/marker to announce.
    const present = new Map<string, { name: string; marker: string }>();
    for (const sys of systems) {
      const e = matchSystem(entries, sys);
      if (e) present.set(`sys:${sys.id}`, { name: sys.name || '?', marker: t(`watchMarker.${e.marker}`) });
    }
    for (const conn of connections) {
      const e = matchConnection(entries, conn);
      if (e) {
        const label = conn.type || t('watchMarker.watch');
        present.set(`conn:${conn.id}`, { name: label, marker: t(`watchMarker.${e.marker}`) });
      }
    }

    const st = stateRef.current;
    // Map switch or watchlist edit → reseed silently (compare entries identity;
    // useWatchlist returns a fresh array whenever the stored value changes).
    if (st.mapId !== activeMapId || st.entries !== entries) {
      stateRef.current = { mapId: activeMapId, entries, alerted: new Set(present.keys()) };
      return;
    }

    for (const [key, info] of present) {
      if (st.alerted.has(key)) continue;
      st.alerted.add(key);
      toast.info(t('watchlist.appeared', { name: info.name, marker: info.marker }));
      if (soundOn) playWatchChime();
    }
    for (const key of Array.from(st.alerted)) {
      if (!present.has(key)) st.alerted.delete(key);
    }
  }, [systems, connections, activeMapId, entries, soundOn, t]);
}
