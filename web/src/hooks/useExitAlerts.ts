import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapStore } from '../store/mapStore';
import { useUserSetting } from './useUserSetting';
import { systemDisplayName } from '../utils/systemName';
import { toast } from '../utils/toastStore';
import {
  NOTIFY, fireDesktopNotification, EXITS_MIN_SECURITY_KEY, EXITS_MIN_SECURITY_DEFAULT,
} from '../utils/notificationPrefs';

// The k-space classes that can be an exit. Wormhole systems never are.
const KSPACE_CLASSES = new Set(['HS', 'LS', 'NS']);

// Matches the watchlist's settling window: a map switch bulk-loads systems, and
// without this every exit already on the chain would fire at once.
const ARM_DELAY_MS = 1500;

let audioCtx: AudioContext | null = null;
function playExitChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    // 660Hz square — the lowest of the four alert tones, and the only square
    // wave, so an exit is distinguishable from K162 (1320 sawtooth), watchlist
    // (988 triangle) and proximity (880 sine) without looking.
    o.frequency.value = 660;
    o.type = 'square';
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.34);
  } catch { /* audio blocked / unavailable — silent fail */ }
}

/**
 * Mounted once (in MapCanvas). Fires a one-shot alert the first time a k-space
 * exit at or above the configured security appears on the active map — the
 * in-app counterpart to the Discord exit broadcast, and opt-in in the same way.
 *
 * Off by default: with both channels off nothing fires, toast included, so the
 * alert is genuinely silent rather than half-on. Exits are keyed by system id
 * and alerted once; one that leaves the map re-arms.
 */
export function useExitAlerts() {
  const { t } = useTranslation();
  const systems     = useMapStore((s) => s.map.systems);
  const activeMapId = useMapStore((s) => s.activeMapId);
  const [soundOn]   = useUserSetting<boolean>(NOTIFY.exitsSound, false);
  const [desktopOn] = useUserSetting<boolean>(NOTIFY.exitsDesktop, false);
  const [minSec]    = useUserSetting<number>(EXITS_MIN_SECURITY_KEY, EXITS_MIN_SECURITY_DEFAULT);

  const stateRef = useRef<{ mapId: string | null; alerted: Set<string>; armAt: number }>({
    mapId: null, alerted: new Set(), armAt: 0,
  });

  useEffect(() => {
    if (!soundOn && !desktopOn) {
      // Off — drop any seeded state so switching it on later doesn't
      // immediately announce everything already on the chain.
      stateRef.current = { mapId: activeMapId, alerted: new Set(), armAt: 0 };
      return;
    }

    const present = new Map<string, { name: string; security: number }>();
    for (const sys of systems) {
      if (!KSPACE_CLASSES.has(sys.systemClass)) continue;
      const sec = sys.security;
      // An unresolved placeholder has no security yet; skip rather than guess.
      if (sec == null || !Number.isFinite(Number(sec))) continue;
      if (Number(sec) < minSec) continue;
      present.set(sys.id, { name: systemDisplayName(sys) || '?', security: Number(sec) });
    }

    const st = stateRef.current;
    // Map switch (or the alert being switched on) → seed silently and settle.
    if (st.mapId !== activeMapId) {
      stateRef.current = { mapId: activeMapId, alerted: new Set(present.keys()), armAt: Date.now() + ARM_DELAY_MS };
      return;
    }
    if (Date.now() < st.armAt) {
      st.alerted = new Set(present.keys());
      return;
    }

    for (const [id, info] of present) {
      if (st.alerted.has(id)) continue;
      st.alerted.add(id);
      const body = t('exits.appeared', { name: info.name, security: info.security.toFixed(1) });
      toast.info(body);
      if (soundOn) playExitChime();
      if (desktopOn) fireDesktopNotification(t('exits.notifTitle'), body, `nexum-exit-${id}`);
    }
    for (const id of Array.from(st.alerted)) {
      if (!present.has(id)) st.alerted.delete(id);
    }
  }, [systems, activeMapId, soundOn, desktopOn, minSec, t]);
}
