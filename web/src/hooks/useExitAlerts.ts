import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapStore } from '../store/mapStore';
import { useUserSetting } from './useUserSetting';
import { systemDisplayName } from '../utils/systemName';
import { toast } from '../utils/toastStore';
import {
  NOTIFY, alertGain, fireDesktopNotification, EXITS_MIN_SECURITY_KEY, EXITS_MIN_SECURITY_DEFAULT,
  EXITS_MIN_SECURITY_OFF,
} from '../utils/notificationPrefs';

// The k-space classes that can be an exit. Wormhole systems never are.
const KSPACE_CLASSES = new Set(['HS', 'LS', 'NS']);

// Matches the watchlist's settling window: a map switch bulk-loads systems, and
// without this every exit already on the chain would fire at once.
const ARM_DELAY_MS = 1500;

// More new exits than this in one go and they're summarised in one alert.
const MAX_SEPARATE_ALERTS = 3;

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
    g.gain.exponentialRampToValueAtTime(alertGain(0.14), ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.34);
  } catch { /* audio blocked / unavailable — silent fail */ }
}

/**
 * Mounted once (in MapCanvas). Fires a one-shot alert when a new wormhole
 * connection puts a k-space system at or above the configured security on the
 * active map — the in-app counterpart to the Discord exit broadcast, and
 * opt-in in the same way.
 *
 * An exit is the k-space end of a wormhole. Systems joined by stargates,
 * Ansiblexes or cynos are never exits, however many there are. Alerts are keyed
 * by connection, so a second hole into a system already on the map is news,
 * and a hole that collapses and is re-found (a new connection) is too. Each
 * connection alerts at most once per visit to a map, even if it briefly drops
 * out (an undo, a refetch).
 *
 * Off by default: with both channels off nothing fires, toast included. Turning
 * it on, raising the threshold or switching map takes in what's already there
 * silently — only connections that appear after that alert.
 */
export function useExitAlerts() {
  const { t } = useTranslation();
  const systems     = useMapStore((s) => s.map.systems);
  const connections = useMapStore((s) => s.map.connections);
  const activeMapId = useMapStore((s) => s.activeMapId);
  const [soundOn]   = useUserSetting<boolean>(NOTIFY.exitsSound, false);
  const [desktopOn] = useUserSetting<boolean>(NOTIFY.exitsDesktop, false);
  const [minSec]    = useUserSetting<number>(EXITS_MIN_SECURITY_KEY, EXITS_MIN_SECURITY_DEFAULT);

  // `key` is what the seen set was built for (map + threshold). Anything that
  // changes it re-seeds silently instead of announcing the whole chain.
  const stateRef = useRef<{ key: string | null; alerted: Set<string>; armAt: number }>({
    key: null, alerted: new Set(), armAt: 0,
  });

  useEffect(() => {
    if (minSec >= EXITS_MIN_SECURITY_OFF || (!soundOn && !desktopOn)) {
      // Off. Forget everything, so switching back on starts with a silent seed.
      stateRef.current = { key: null, alerted: new Set(), armAt: 0 };
      return;
    }

    const byId = new Map(systems.map((s) => [s.id, s]));
    const exitEnd = (id: string) => {
      const sys = byId.get(id);
      if (!sys || !KSPACE_CLASSES.has(sys.systemClass)) return null;
      // An unresolved placeholder has no security yet; skip rather than guess.
      const sec = sys.security;
      if (sec == null || !Number.isFinite(Number(sec)) || Number(sec) < minSec) return null;
      return { id: sys.id, name: systemDisplayName(sys) || '?', security: Number(sec) };
    };

    // Live wormhole connections with a qualifying k-space end, by connection id.
    const present = new Map<string, { id: string; name: string; security: number }>();
    for (const c of connections) {
      if (c.connectionType !== 'standard' || c.broken) continue;
      const end = exitEnd(c.sourceId) ?? exitEnd(c.targetId);
      if (end) present.set(c.id, end);
    }

    const st = stateRef.current;
    const key = `${activeMapId ?? ''}|${minSec}`;
    // Switched on, map switched, or threshold changed → seed silently and settle.
    if (st.key !== key) {
      stateRef.current = { key, alerted: new Set(present.keys()), armAt: Date.now() + ARM_DELAY_MS };
      return;
    }
    if (Date.now() < st.armAt) {
      for (const id of present.keys()) st.alerted.add(id);
      return;
    }

    // New this pass, one per system.
    const fresh = new Map<string, { name: string; security: number }>();
    for (const [connId, info] of present) {
      if (st.alerted.has(connId)) continue;
      st.alerted.add(connId);
      fresh.set(info.id, info);
    }
    if (fresh.size > 0) {
      // A burst (a pasted or imported chain) gets one summary, never a stream.
      const alerts = fresh.size > MAX_SEPARATE_ALERTS
        ? [{ tag: 'nexum-exit-many', body: t('exits.appearedMany', { count: fresh.size }) }]
        : [...fresh].map(([id, info]) => ({
            tag:  `nexum-exit-${id}`,
            body: t('exits.appeared', { name: info.name, security: info.security.toFixed(1) }),
          }));
      for (const a of alerts) {
        toast.info(a.body);
        if (desktopOn) fireDesktopNotification(t('exits.notifTitle'), a.body, a.tag);
      }
      if (soundOn) playExitChime();
    }
  }, [systems, connections, activeMapId, soundOn, desktopOn, minSec, t]);
}
