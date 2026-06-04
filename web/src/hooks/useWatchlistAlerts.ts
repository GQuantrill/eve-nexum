import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapStore } from '../store/mapStore';
import { useUserSetting } from './useUserSetting';
import { useWatchIndex } from './useWatchlist';
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

function nameKey(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

/**
 * Mounted once (in MapCanvas). Watches the active map's systems against the
 * user's watchlist and fires a one-shot toast + chime the first time a watched
 * hole *appears* on the map. On a map switch (or first load) the currently
 * present watched systems are seeded silently, so loading a map that already
 * contains a watched hole doesn't barrage you — only genuine new appearances
 * chime. A watched system that leaves the map re-arms, so it alerts again if
 * it reappears.
 */
export function useWatchlistAlerts() {
  const { t } = useTranslation();
  const systems     = useMapStore((s) => s.map.systems);
  const activeMapId = useMapStore((s) => s.activeMapId);
  const index       = useWatchIndex();
  const [soundOn]   = useUserSetting<boolean>('nexum.watchlist.sound', true);

  const stateRef = useRef<{ mapId: string | null; alerted: Set<string> }>({ mapId: null, alerted: new Set() });

  useEffect(() => {
    const present = new Set<string>();
    for (const s of systems) {
      const key = nameKey(s.name);
      if (key && index.has(key)) present.add(key);
    }

    const st = stateRef.current;
    // Map switch / first run: seed silently.
    if (st.mapId !== activeMapId) {
      stateRef.current = { mapId: activeMapId, alerted: new Set(present) };
      return;
    }

    // Newly-appeared watched holes → alert once each.
    for (const key of present) {
      if (st.alerted.has(key)) continue;
      st.alerted.add(key);
      const entry = index.get(key);
      if (!entry) continue;
      const sys = systems.find((s) => nameKey(s.name) === key);
      toast.info(t('watchlist.appeared', {
        name:   sys?.name ?? entry.query,
        marker: t(`watchMarker.${entry.marker}`),
      }));
      if (soundOn) playWatchChime();
    }
    // Watched holes that left → re-arm so they can alert again next time.
    for (const key of Array.from(st.alerted)) {
      if (!present.has(key)) st.alerted.delete(key);
    }
  }, [systems, activeMapId, index, soundOn, t]);
}
