import { useSyncExternalStore } from 'react';
import { onDesktopEvent } from './bridge';
import { useMapStore } from '../store/mapStore';
import { alertGain } from '../utils/notificationPrefs';

// Desktop only: the app follows the pilot's chosen intel channels (EVE chat
// logs) and sends each new line here. A line naming a system on the open map
// (its full name, as EVE writes a system dragged into chat) makes that node
// pulse red for five seconds, with a sound unless the pilot turned it off in
// the desktop settings. "clr"/"clear" lines are reports that a system is
// empty, so they don't alert. Nothing here is sent to the server.

const PULSE_MS = 5_000;
const CLEAR = /(^|[^a-z0-9])(clr|clear)([^a-z0-9]|$)/i;

export interface IntelLine { channel: string; sender: string; text: string; at: number; sound: boolean }

// ── Which systems are pulsing ───────────────────────────────────────────────
const pulsing = new Map<string, number>();   // map system id -> pulse end (ms)
const subs = new Set<() => void>();
const bump = () => { subs.forEach((f) => f()); };
const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };

function pulse(systemId: string): void {
  const until = Date.now() + PULSE_MS;
  pulsing.set(systemId, until);
  bump();
  setTimeout(() => {
    // A newer report about the same system extends the pulse.
    if ((pulsing.get(systemId) ?? 0) <= Date.now()) { pulsing.delete(systemId); bump(); }
  }, PULSE_MS + 50);
}

/** True while an intel report about this map system is pulsing. */
export function useIntelPulse(systemId: string): boolean {
  // A boolean snapshot, so only nodes whose pulse starts or ends re-render.
  return useSyncExternalStore(subscribe, () => pulsing.has(systemId), () => false);
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
    ids.forEach(pulse);
    if (line.sound) playAlert();
  });
}
