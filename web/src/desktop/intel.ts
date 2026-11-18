import { useSyncExternalStore } from 'react';
import { onDesktopEvent } from './bridge';
import { useMapStore } from '../store/mapStore';
import { alertGain } from '../utils/notificationPrefs';

// Desktop only: the app follows the pilot's chosen intel channels (EVE chat
// logs) and sends each new line here. A line naming a system on the open map
// (its full name, as EVE writes a system dragged into chat) makes that node
// pulse red, with a sound. How long it pulses (5-30 s), how strongly (or not
// at all: sound only) and whether there's a sound are the pilot's choices in
// the desktop settings, and arrive with each line. "clr"/"clear" lines are reports that a system is
// empty, so they don't alert. Nothing here is sent to the server.

export type IntelPulse = 'off' | 'subtle' | 'normal' | 'strong';
const PULSES: IntelPulse[] = ['off', 'subtle', 'normal', 'strong'];
const SECONDS = [5, 10, 15, 30];
const CLEAR = /(^|[^a-z0-9])(clr|clear)([^a-z0-9]|$)/i;

export interface IntelLine {
  channel: string; sender: string; text: string; at: number; sound: boolean;
  /** Older app versions don't send these: 5 s, normal. */
  pulseSecs?: number; pulse?: IntelPulse;
}

// ── Which systems are pulsing ───────────────────────────────────────────────
const pulsing = new Map<string, { until: number; level: IntelPulse }>();
const subs = new Set<() => void>();
const bump = () => { subs.forEach((f) => f()); };
const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };

function pulse(systemId: string, ms: number, level: IntelPulse): void {
  pulsing.set(systemId, { until: Date.now() + ms, level });
  bump();
  setTimeout(() => {
    // A newer report about the same system extends the pulse.
    if ((pulsing.get(systemId)?.until ?? 0) <= Date.now()) { pulsing.delete(systemId); bump(); }
  }, ms + 50);
}

/** The pulse strength while an intel report about this map system is
 *  pulsing, else null. */
export function useIntelPulse(systemId: string): Exclude<IntelPulse, 'off'> | null {
  // A plain-value snapshot, so only nodes whose pulse starts or ends re-render.
  return useSyncExternalStore(subscribe, () => {
    const level = pulsing.get(systemId)?.level;
    return level && level !== 'off' ? level : null;
  }, () => null);
}

// ── Matching ────────────────────────────────────────────────────────────────
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The map systems a line names by full name (any case, whole word only). */
export function systemsNamed(text: string, systems: { id: string; name: string }[]): string[] {
  if (CLEAR.test(text)) return [];
  return systems
    .filter((s) => s.name.length > 1
      && new RegExp(`(^|[^A-Za-z0-9-])${escape(s.name)}([^A-Za-z0-9-]|$)`, 'i').test(text))
    .map((s) => s.id);
}

// ── Sound ───────────────────────────────────────────────────────────────────
let audioCtx: AudioContext | null = null;
function playAlert(): void {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const ctx = audioCtx;
    // Two short low-high tones: distinct from the proximity beep.
    [0, 0.18].forEach((delay, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i === 0 ? 660 : 990;
      const t = ctx.currentTime + delay;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(alertGain(0.25), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.16);
    });
  } catch { /* audio blocked or unavailable */ }
}

// ── Listener ────────────────────────────────────────────────────────────────
const MAX_AGE_MS = 60_000;   // a line older than this is history, not intel

export function startIntel(): () => void {
  return onDesktopEvent<IntelLine>('nexum://intel', (line) => {
    if (Date.now() - line.at > MAX_AGE_MS) return;
    const ids = systemsNamed(line.text, useMapStore.getState().map.systems);
    if (ids.length === 0) return;
    const level = PULSES.includes(line.pulse as IntelPulse) ? line.pulse! : 'normal';
    const secs = SECONDS.includes(line.pulseSecs ?? 0) ? line.pulseSecs! : 5;
    if (level !== 'off') ids.forEach((id) => pulse(id, secs * 1000, level));
    if (line.sound) playAlert();
  });
}
