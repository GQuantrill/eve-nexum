import { useSyncExternalStore } from 'react';
import { onDesktopEvent } from './bridge';
import { useMapStore } from '../store/mapStore';
import { alertGain } from '../utils/notificationPrefs';
import { api } from '../api/client';

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

// ── Reports anywhere (for proximity alerts) ─────────────────────────────────
// The pulse only needs the open map's systems, but a hostile two gates out is
// usually NOT on a wormhole map. So every line's words are also looked up
// against all systems (batched every two seconds, each word cached whether or
// not it was a system, to stay well inside the lookup's rate limit), and each
// system reported is kept for five minutes, or until a "clr" for it. The
// proximity alerts (hooks/useProximityAlerts) measure the jumps.

export const REPORT_MS = 5 * 60_000;
const BATCH_MS = 2_000;
const BATCH_MAX = 60;

export interface IntelReport { eveSystemId: number; name: string; at: number }

let reports = new Map<number, IntelReport>();
const reportSubs = new Set<() => void>();
const publish = (next: Map<number, IntelReport>) => { reports = next; reportSubs.forEach((f) => f()); };
const subscribeReports = (cb: () => void) => { reportSubs.add(cb); return () => { reportSubs.delete(cb); }; };

/** Systems reported in intel in the last five minutes (and not cleared). */
export function useIntelReports(): Map<number, IntelReport> {
  return useSyncExternalStore(subscribeReports, () => reports, () => reports);
}

function expireReports(): void {
  const now = Date.now();
  if ([...reports.values()].some((r) => now - r.at > REPORT_MS)) {
    publish(new Map([...reports].filter(([, r]) => now - r.at <= REPORT_MS)));
  }
}

/** The words of a line that could be a system name: each word, and each pair
 *  of words (for the few two-word names), without trailing marks like "*". */
export function candidateNames(text: string): string[] {
  const words = text.split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''))
    .filter((w) => w.length >= 2 && w.length <= 32);
  const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return [...new Set([...words, ...pairs].map((w) => w.toLowerCase()))];
}

const known = new Map<string, { eveSystemId: number; name: string } | null>();
let queued: IntelLine[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  flushTimer = null;
  const lines = queued;
  queued = [];
  const unknown = [...new Set(lines.flatMap((l) => candidateNames(l.text)))].filter((n) => !known.has(n));
  for (let i = 0; i < unknown.length; i += BATCH_MAX) {
    const batch = unknown.slice(i, i + BATCH_MAX);
    try {
      const found = await api<{ eveSystemId: number; name: string }[]>(
        `/api/systems/lookup?names=${encodeURIComponent(batch.join(','))}`);
      batch.forEach((n) => known.set(n, null));
      found.forEach((s) => known.set(s.name.toLowerCase(), { eveSystemId: s.eveSystemId, name: s.name }));
    } catch { /* rate-limited or offline: try these words again next time */ }
  }
  const next = new Map(reports);
  for (const line of lines) {
    const clear = CLEAR.test(line.text);
    for (const n of candidateNames(line.text)) {
      const sys = known.get(n);
      if (!sys) continue;
      if (clear) next.delete(sys.eveSystemId);
      else next.set(sys.eveSystemId, { ...sys, at: line.at });
    }
  }
  publish(next);
}

function queueReport(line: IntelLine): void {
  queued.push(line);
  flushTimer ??= setTimeout(() => { void flush(); }, BATCH_MS);
}

// ── Listener ────────────────────────────────────────────────────────────────
const MAX_AGE_MS = 60_000;   // a line older than this is history, not intel

export function startIntel(): () => void {
  const expiry = setInterval(expireReports, 15_000);
  const off = onDesktopEvent<IntelLine>('nexum://intel', (line) => {
    if (Date.now() - line.at > MAX_AGE_MS) return;
    queueReport(line);
    const ids = systemsNamed(line.text, useMapStore.getState().map.systems);
    if (ids.length === 0) return;
    const level = PULSES.includes(line.pulse as IntelPulse) ? line.pulse! : 'normal';
    const secs = SECONDS.includes(line.pulseSecs ?? 0) ? line.pulseSecs! : 5;
    if (level !== 'off') ids.forEach((id) => pulse(id, secs * 1000, level));
    if (line.sound) playAlert();
  });
  return () => { off(); clearInterval(expiry); };
}
