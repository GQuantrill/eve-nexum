import { useEffect, useMemo, useRef, useState } from 'react';
import { useCharacterLocation } from './useCharacterLocation';
import { useIncursions } from './useIncursions';
import { useInsurgency } from './useInsurgency';
import { useRoute } from './useRoute';
import { useStandings } from './useStandings';
import { ensureSovLoaded, getSovEntries } from './useSovData';
import { useUserSetting, readUserSetting, writeUserSetting } from './useUserSetting';
import { NOTIFY, notifyOn, alertGain } from '../utils/notificationPrefs';
import { useDebugFlag } from '../utils/debugFlags';
import { desktopNotify, desktopAttention, desktopInvoke, isDesktop } from '../desktop/bridge';
import { useIntelReports } from '../desktop/intel';
import { playIntelSound } from '../desktop/intelSounds';
import type { IntelSpeech } from '../desktop/intel';
import i18n from '../i18n';

/** 'intel': a system named in one of the pilot's intel channels (desktop app). */
export type ThreatKind = 'incursion' | 'insurgency' | 'hostile-sov' | 'intel';

export interface NearestThreat {
  kind:        ThreatKind;
  jumps:       number;
  systemId:    number;
}

const THRESHOLD_KEY = 'nexum.proximityThreshold';
const DEFAULT_THRESHOLD = 2;

// Stand-in threat shown when nexumDebug.showThreats() is on but nothing real is
// detected (e.g. testing in the browser with no live character location, so no
// route origin exists to measure real threats from). Purely for eyeballing the
// proximity chip; never used outside debug mode.
const DEMO_THREAT: NearestThreat = { kind: 'incursion', jumps: 2, systemId: -1 };

function clamp(n: number): number {
  return Math.max(0, Math.min(5, Math.floor(n)));
}

export function readThreshold(): number {
  return readUserSetting<number>(THRESHOLD_KEY, DEFAULT_THRESHOLD);
}

export function writeThreshold(n: number): void {
  writeUserSetting(THRESHOLD_KEY, clamp(n));
}

/** Threshold-watching hook. Returns the current threshold and a setter. */
export function useProximityThreshold(): [number, (n: number) => void] {
  const [threshold, setThreshold] = useUserSetting<number>(THRESHOLD_KEY, DEFAULT_THRESHOLD);
  return [
    Number.isFinite(threshold) && threshold >= 0 && threshold <= 5 ? threshold : DEFAULT_THRESHOLD,
    (n: number) => setThreshold(clamp(n)),
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
    g.gain.exponentialRampToValueAtTime(alertGain(0.25), ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch { /* audio blocked / unavailable — silent fail */ }
}

function fireBrowserNotification(kind: ThreatKind, jumps: number, sysName: string) {
  const title =
    kind === 'incursion'   ? 'Incursion nearby' :
    kind === 'insurgency'  ? 'Insurgency nearby' :
    kind === 'hostile-sov' ? 'Hostile sov nearby' :
    'Threat nearby';
  const body  = jumps === 0 ? `You are in ${sysName}` : `${jumps} jump${jumps === 1 ? '' : 's'} from ${sysName}`;
  // Inside the desktop app the system notification comes from the app itself.
  if (desktopNotify(title, body)) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
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
  const intel      = useIntelReports();
  const [threshold] = useProximityThreshold();
  // nexumDebug.showThreats() flips this to surface the nearest threat in the
  // toolbar regardless of the alert threshold. Only affects what's DISPLAYED —
  // the notification/beep below still uses the real threshold so debug mode
  // doesn't spam alerts for far-off threats.
  const debugShowThreats = useDebugFlag('showThreats');

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
    // Intel reports (desktop app only; always empty on the web). The other
    // kinds win a tie: they say more about what's there.
    for (const r of intel.values()) {
      if (ids.has(r.eveSystemId)) continue;
      ids.add(r.eveSystemId);
      kinds.set(r.eveSystemId, 'intel');
      names.set(r.eveSystemId, r.name);
    }
    return { targetIds: [...ids], kindMap: kinds, nameMap: names };
  }, [incursions, insurgency, sovReady, standings, intel]);

  const routes = useRoute(location.system?.eveSystemId ?? null, targetIds);

  // `nearest` (the toolbar chip) counts intel; `nearestFixed` (the alert on
  // entering a threat's range) doesn't, because intel has its own alert below,
  // per report, so a sighting nearby isn't announced twice.
  const [nearest, nearestFixed] = useMemo(() => [
    pickNearest(routes, kindMap, nameMap, false),
    pickNearest(routes, kindMap, nameMap, true),
  ], [routes, kindMap, nameMap]);

  // Fire-once-on-entry tracker
  const inZoneRef = useRef(false);
  useEffect(() => {
    const inZone = !!nearestFixed && nearestFixed.jumps <= threshold;
    if (inZone && !inZoneRef.current && nearestFixed) {
      const sysName = nameMap.get(nearestFixed.systemId) ?? String(nearestFixed.systemId);
      if (notifyOn(NOTIFY.proximityDesktop)) fireBrowserNotification(nearestFixed.kind, nearestFixed.jumps, sysName);
      if (notifyOn(NOTIFY.proximitySound)) playBeep();
      inZoneRef.current = true;
    } else if (!inZone && (nearestFixed || targetIds.length === 0)) {
      // Only once we KNOW we're out of range: the nearest threat is beyond the
      // threshold, or there are none. No location yet, or a route lookup that
      // failed, says nothing either way — forgetting we'd alerted then would
      // re-alert the same threat the moment the next lookup succeeds.
      inZoneRef.current = false;
    }
  }, [nearestFixed, threshold, nameMap, targetIds.length]);

  // Intel, once per report (a fresh sighting of the same system alerts again):
  // - "Threat reported" (notification, taskbar flash) within the proximity
  //   alert range;
  // - sound and voice within the pilot's intel range (desktop settings): any
  //   system on the open map, or within a number of jumps. On the map, the
  //   sound has already played as the line arrived (desktop/intel.ts).
  const alertedRef = useRef(new Set<string>());
  const located = location.system?.eveSystemId != null;
  useEffect(() => {
    for (const r of intel.values()) {
      const key = `${r.eveSystemId}:${r.at}`;
      if (alertedRef.current.has(key)) continue;
      const route = routes[r.eveSystemId];
      // Wait for the distance while it's being looked up. Without a location
      // there is none: only "anything on the map" can still alert.
      if (!route && located) continue;
      alertedRef.current.add(key);
      const jumps = route?.jumps ?? null;
      if (jumps !== null && jumps <= threshold) {
        if (notifyOn(NOTIFY.proximityDesktop)) fireIntelNotification(r.name, jumps);
        desktopAttention();
      }
      const inRange = r.range === null ? r.onMap : jumps !== null && jumps <= r.range;
      if (!inRange) continue;
      if (r.range !== null && r.sound) playIntelSound(r.soundName);
      if (r.speech) speakIntel(r.name, jumps, r.speech);
    }
  }, [intel, routes, threshold, located]);

  // Desktop app: the intel overlay's list (overlay.rs), nearest first. An
  // older app without the overlay just refuses the call.
  const hereName = location.system?.name ?? null;
  useEffect(() => {
    if (!isDesktop()) return;
    const reports = [...intel.values()]
      .map((r) => ({ name: r.name, jumps: routes[r.eveSystemId]?.jumps ?? null, at: r.at }))
      .sort((a, b) => (a.jumps ?? Infinity) - (b.jumps ?? Infinity) || b.at - a.at)
      .slice(0, 12);
    desktopInvoke('overlay_update', { data: { here: hereName, reports } }).catch(() => { /* older app */ });
  }, [intel, routes, hereName]);

  // Debug: surface a threat regardless of the alert threshold. Show the real
  // nearest one if there is any (with real jumps), otherwise a demo stand-in so
  // the chip is always visible for eyeballing. Only the RETURNED values change —
  // the notification/beep above still keys off the real `nearest` + threshold.
  if (debugShowThreats) {
    return { nearest: nearest ?? DEMO_THREAT, threshold: Number.MAX_SAFE_INTEGER };
  }
  return { nearest, threshold };
}

function fireIntelNotification(sysName: string, jumps: number) {
  const title = i18n.t('toolbar.proximity.intel');
  const body = jumps === 0
    ? i18n.t('toolbar.proximity.intelHere', { system: sysName })
    : i18n.t('toolbar.proximity.intelNear', { system: sysName, count: jumps });
  if (desktopNotify(title, body)) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag: `nexum-intel-${sysName}` }); } catch { /* ignore */ }
}

const SPEECH_RATES: Record<string, number> = { slow: 0.8, normal: 1, fast: 1.3 };

// Read a report aloud, in the site's language, at the pilot's volume, speed
// and voice. A newer report cuts off one still being read: the latest is what
// matters.
function speakIntel(sysName: string, jumps: number | null, speech: IntelSpeech) {
  if (typeof speechSynthesis === 'undefined') return;
  const text = jumps === null
    ? i18n.t('toolbar.proximity.intelSpeakReported', { system: sysName })
    : jumps === 0
    ? i18n.t('toolbar.proximity.intelSpeakHere', { system: sysName })
    : i18n.t('toolbar.proximity.intelSpeak', { system: sysName, count: jumps });
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = i18n.language;
    u.volume = Math.min(100, Math.max(0, speech.volume)) / 100;
    u.rate = SPEECH_RATES[speech.rate] ?? 1;
    const voice = speech.voice ? speechSynthesis.getVoices().find((v) => v.voiceURI === speech.voice) : undefined;
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  } catch { /* no voices: stay silent */ }
}

function pickNearest(
  routes: Record<string, { jumps: number; path: { name: string }[] }>,
  kindMap: Map<number, ThreatKind>,
  nameMap: Map<number, string>,
  skipIntel: boolean,
): NearestThreat | null {
  let best: NearestThreat | null = null;
  for (const [idStr, entry] of Object.entries(routes)) {
    const id    = Number(idStr);
    const kind  = kindMap.get(id);
    if (!kind || (skipIntel && kind === 'intel')) continue;
    if (!best || entry.jumps < best.jumps) {
      best = { kind, jumps: entry.jumps, systemId: id };
      // Capture name from the route path's last entry for the notification body
      const last = entry.path[entry.path.length - 1];
      if (last) nameMap.set(id, last.name);
    }
  }
  return best;
}
