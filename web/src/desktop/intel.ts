import { useSyncExternalStore } from 'react';
import { onDesktopEvent, desktopInvoke, isDesktop } from './bridge';
import { useMapStore } from '../store/mapStore';
import { playIntelSound, DEFAULT_INTEL_SOUND } from './intelSounds';
import { NOTIFY, notifyOn, INTEL_SOUND_NAME_KEY } from '../utils/notificationPrefs';
import { api } from '../api/client';
import { readUserSetting } from '../hooks/useUserSetting';
import { sanitiseWatched, WATCH_KEY, type WatchedPilot } from '../utils/pilotWatch';

// Desktop only: the app follows the pilot's chosen intel channels (EVE chat
// logs) and sends each new line here. A line naming a system on the open map
// (its full name, as EVE writes a system dragged into chat) makes that node
// pulse red, with a sound. How long it pulses (5-30 s), how strongly (or not
// at all: sound only) and whether there's a sound are the pilot's choices in
// the desktop settings, and arrive with each line. "clr"/"clear" lines are reports that a system is
// empty, so they don't alert. The lines themselves are never sent to the
// server; only their words go, in the system-name lookup below (not stored).
// The one exception is a pilot on the pilot's own watch list: when a live line
// names one beside a system, that pilot and system (not the line) are recorded
// as a sighting on the open map (recordWatched).

export type IntelPulse = 'off' | 'subtle' | 'normal' | 'strong';
const PULSES: IntelPulse[] = ['off', 'subtle', 'normal', 'strong'];
const SECONDS = [5, 10, 15, 30];
const CLEAR = /(^|[^a-z0-9])(clr|clear)([^a-z0-9]|$)/i;

// The app also sends its own (older) sound and speech settings with each line
// (sound, soundName, speak, speakVolume...). They're ignored: whether intel
// makes a sound, which, and the voice are Nexum's Notifications and Announcer
// settings now, so sound is managed in one place.
export interface IntelLine {
  channel: string; sender: string; text: string; at: number;
  /** Older app versions don't send these: 5 s, normal. */
  pulseSecs?: number; pulse?: IntelPulse;
  /** Sound and voice only within this many jumps of the pilot; null (or an
   *  older app that doesn't send it) = for any system on the open map. */
  alertRange?: number | null;
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

export interface IntelReport {
  eveSystemId: number; name: string; at: number;
  /** Sound and voice only within this many jumps; null = for any system on
   *  the open map (see onMap). */
  range: number | null;
  /** The system is on the open map. */
  onMap: boolean;
}

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
// `report`: false for the feed's history, which is looked up only so its
// system names can be highlighted. Old intel must never alert.
let queued: { line: IntelLine; report: boolean }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  flushTimer = null;
  const items = queued;
  queued = [];
  const unknown = [...new Set(items.flatMap((q) => candidateNames(q.line.text)))].filter((n) => !known.has(n));
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
  const onMap = new Set(useMapStore.getState().map.systems.map((s) => s.name.toLowerCase()));
  for (const { line } of items.filter((q) => q.report)) {
    const clear = CLEAR.test(line.text);
    for (const n of candidateNames(line.text)) {
      const sys = known.get(n);
      if (!sys) continue;
      if (clear) next.delete(sys.eveSystemId);
      else next.set(sys.eveSystemId, {
        ...sys,
        at: line.at,
        range: typeof line.alertRange === 'number' ? line.alertRange : null,
        onMap: onMap.has(sys.name.toLowerCase()),
      });
    }
  }
  publish(next);
  setFeed({ ...feed });   // re-render the feed with the newly known names
  if (recording) recordWatched(items.filter((q) => q.report).map((q) => q.line));
}

// Only the main window records, so a pop-out doesn't send every line twice.
let recording = false;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `name` appears in `text` as whole words. */
export function namesPilot(text: string, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(n)}([^a-z0-9]|$)`, 'i').test(text);
}

/** Record each watched pilot named in a live line beside a known system. The
 *  reporter themselves is skipped, and so are "clr" lines. */
function recordWatched(lines: IntelLine[], only?: WatchedPilot[], withTime = false): Promise<unknown>[] {
  const watched = only ?? sanitiseWatched(readUserSetting<unknown>(WATCH_KEY, []));
  const mapId = useMapStore.getState().activeMapId;
  const posts: Promise<unknown>[] = [];
  if (watched.length === 0 || !mapId) return posts;
  for (const line of lines) {
    if (CLEAR.test(line.text)) continue;
    const pilots = watched.filter((w) =>
      w.name.toLowerCase() !== line.sender.trim().toLowerCase() && namesPilot(line.text, w.name));
    if (pilots.length === 0) continue;
    // The system: the first word (or pair) that is one, ignoring the pilots' own names.
    const inNames = new Set(pilots.flatMap((p) => candidateNames(p.name)));
    const sys = candidateNames(line.text).filter((n) => !inNames.has(n)).map((n) => known.get(n))
      .find((v): v is { eveSystemId: number; name: string } => !!v);
    if (!sys) continue;
    posts.push(api('/api/pilots/sightings', {
      method: 'POST',
      body: JSON.stringify({
        mapId, eveSystemId: sys.eveSystemId, pilots: pilots.slice(0, 20),
        ...(withTime ? { seenAt: line.at } : {}),
      }),
    }).catch(() => { /* read-only map, offline: not worth a toast */ }));
  }
  return posts;
}

/**
 * A pilot just added to the watch list: look back over the intel already in
 * the feed, so a report posted moments before they were watched still counts
 * (each at the time it was posted; the server ignores one it already has).
 * Lines arrive being checked against the watch list as it was then, so
 * without this, watching someone who was just reported shows them unseen.
 */
export async function recordWatchedFromFeed(pilots: WatchedPilot[]): Promise<void> {
  if (!recording || pilots.length === 0) return;
  const cutoff = Date.now() - SIGHTING_MS;
  await Promise.all(recordWatched(feed.lines.filter((l) => l.at >= cutoff), pilots, true));
}
const SIGHTING_MS = 30 * 86_400_000;

function queueLookup(line: IntelLine, report: boolean): void {
  queued.push({ line, report });
  flushTimer ??= setTimeout(() => { void flush(); }, BATCH_MS);
}

// ── Feed (the sidebar's Intel pane) ─────────────────────────────────────────
// Recent lines from every channel, newest last, and the pilot's channels. The
// app keeps the last 100 (and a look back into each log when it's
// first opened), so the pane has something to show the moment it mounts.

const FEED_MAX = 100;
export interface IntelFeed { channels: string[]; lines: IntelLine[] }
let feed: IntelFeed = { channels: [], lines: [] };
const feedSubs = new Set<() => void>();
const setFeed = (next: IntelFeed) => { feed = next; feedSubs.forEach((f) => f()); };
const subscribeFeed = (cb: () => void) => { feedSubs.add(cb); return () => { feedSubs.delete(cb); }; };
const lineKey = (l: IntelLine) => `${l.channel}|${l.at}|${l.sender}|${l.text}`;

/** The intel feed: the pilot's channels and recent lines (desktop app). */
export function useIntelFeed(): IntelFeed {
  return useSyncExternalStore(subscribeFeed, () => feed, () => feed);
}

function addToFeed(lines: IntelLine[], channels?: string[]): void {
  const seen = new Set(feed.lines.map(lineKey));
  const merged = [...feed.lines, ...lines.filter((l) => !seen.has(lineKey(l)))]
    .sort((a, b) => a.at - b.at)
    .slice(-FEED_MAX);
  // Channels: the pilot's list, plus any a line came from (an older app
  // version doesn't send the list).
  const names = [...(channels ?? feed.channels)];
  for (const l of merged) if (!names.some((c) => c.toLowerCase() === l.channel.toLowerCase())) names.push(l.channel);
  setFeed({ channels: names, lines: merged });
}

/** Load the app's recent lines and channels (again: cheap, deduplicated). */
export function refreshIntelFeed(): void {
  if (!isDesktop()) return;
  desktopInvoke<IntelFeed>('intel_feed')
    .then((f) => {
      addToFeed(f.lines ?? [], f.channels ?? []);
      (f.lines ?? []).forEach((l) => queueLookup(l, false));
    })
    .catch(() => { /* an older app without the feed: live lines only */ });
}

/** Open the desktop app's settings (where intel channels are set). */
export function openDesktopSettings(): void {
  void desktopInvoke('open_settings_window').catch(() => {});
}

/** The system a word names, once the word has been looked up and found to
 *  be one (for highlighting in the feed). */
export function knownSystem(word: string): { eveSystemId: number; name: string } | null {
  return known.get(word.toLowerCase()) ?? null;
}

/** Whether a line is a "clear" report. */
export const isClearLine = (text: string): boolean => CLEAR.test(text);

// ── Listener ────────────────────────────────────────────────────────────────
const MAX_AGE_MS = 60_000;   // a line older than this is history, not intel

/** `quiet`: a pop-out window keeps the feed but leaves the pulses and sounds
 *  to the main window. */
export function startIntel(quiet = false): () => void {
  const expiry = setInterval(expireReports, 15_000);
  if (!quiet) recording = true;
  refreshIntelFeed();
  // "Preview" in the app's settings: play that sound here.
  const offPreview = quiet
    ? () => {}
    : onDesktopEvent<string>('nexum://intel-sound-preview', (name) => playIntelSound(name));
  const offChannels = onDesktopEvent<string[]>('nexum://intel-channels', (channels) => {
    // Replaced, not merged: a channel the pilot removed goes from the list.
    setFeed({ ...feed, channels: [...channels] });
  });
  const off = onDesktopEvent<IntelLine>('nexum://intel', (line) => {
    addToFeed([line]);
    // Too old to alert on, but still worth highlighting in the feed.
    if (Date.now() - line.at > MAX_AGE_MS) { queueLookup(line, false); return; }
    queueLookup(line, true);
    if (quiet) return;
    const ids = systemsNamed(line.text, useMapStore.getState().map.systems);
    if (ids.length === 0) return;
    const level = PULSES.includes(line.pulse as IntelPulse) ? line.pulse! : 'normal';
    const secs = SECONDS.includes(line.pulseSecs ?? 0) ? line.pulseSecs! : 5;
    if (level !== 'off') ids.forEach((id) => pulse(id, secs * 1000, level));
    // With a jump range set, the proximity alerts play it once the distance
    // is known (hooks/useProximityAlerts).
    if (notifyOn(NOTIFY.intelSound) && typeof line.alertRange !== 'number') {
      playIntelSound(readUserSetting<string>(INTEL_SOUND_NAME_KEY, DEFAULT_INTEL_SOUND));
    }
  });
  return () => { off(); offChannels(); offPreview(); clearInterval(expiry); if (!quiet) recording = false; };
}
