import { useEffect, useMemo, useRef } from 'react';
import { useAnnouncer, primeAudioOnGesture } from '../audio/announcer';
import { useUserSetting } from './useUserSetting';
import { useCharacterLocation } from './useCharacterLocation';
import { useAccountLocations } from './useAccountLocations';
import { useIncursions } from './useIncursions';
import { useProximityThreshold } from './useProximityAlerts';
import { useRoute } from './useRoute';
import { useKillLog } from '../store/killStore';
import { useRemoteActivity } from '../store/remoteActivityStore';
import { apiUrl } from '../api/client';

// Settings keys (English-only demo branch — see AnnouncerSection). All default ON:
// the announcer is on by default and the user opts out per-event.
export const ANN = {
  enabled:    'nexum.announcer.enabled',
  voice:      'nexum.announcer.voice',
  connect:    'nexum.announcer.ev.connect',
  incursions: 'nexum.announcer.ev.incursions',
  lawless:    'nexum.announcer.ev.lawless',
  kills:      'nexum.announcer.ev.kills',
  newChain:   'nexum.announcer.ev.newChain',
} as const;

interface NearbyLawless { eveSystemId: number; name: string; security: number; jumps: number }

function jumpWord(n: number): string {
  return n === 1 ? '1 jump' : `${n} jumps`;
}

/**
 * The voice announcer's event engine. Mounted once (App). Watches five sources
 * and speaks when the situation CHANGES — never a recap at load: kills are seeded
 * by id and alt online-state by roster, so only genuinely new events fire; the
 * incursion/lawless proximity announcements are nearest-only, fire-once-on-entry
 * (at most one utterance at startup, like the proximity beep). Everything is
 * gated on the master enable + the per-event toggle. The model itself loads
 * lazily inside speak() on the first qualifying event.
 */
export function useAnnouncerEvents(): void {
  const speak = useAnnouncer((s) => s.speak);
  const [enabled]    = useUserSetting<boolean>(ANN.enabled, true);
  const [voice]      = useUserSetting<string>(ANN.voice, 'af_nicole');
  const [evConnect]  = useUserSetting<boolean>(ANN.connect, true);
  const [evIncur]    = useUserSetting<boolean>(ANN.incursions, true);
  const [evLawless]  = useUserSetting<boolean>(ANN.lawless, true);
  const [evKills]    = useUserSetting<boolean>(ANN.kills, true);
  const [evChain]    = useUserSetting<boolean>(ANN.newChain, true);
  const [threshold]  = useProximityThreshold();

  const location   = useCharacterLocation();
  const alts       = useAccountLocations();
  const incursions = useIncursions();
  const killLog    = useKillLog();
  const chainAdds  = useRemoteActivity((s) => s.connectionAdds);

  const currentSys = location.system?.eveSystemId ?? null;
  const inHighsec  = location.system?.systemClass === 'HS';

  // Keep the announcer's active voice in sync with the saved setting so
  // announcements use the picked voice even before the user opens the panel.
  const setAnnVoice = useAnnouncer((s) => s.setVoice);
  useEffect(() => { if (voice) setAnnVoice(voice); }, [voice, setAnnVoice]);

  // Prime the audio context + unlock autoplay on the first user gesture so the
  // first event can be heard. Cheap and idempotent.
  useEffect(() => { if (enabled) primeAudioOnGesture(); }, [enabled]);

  // A speak wrapper that no-ops unless the announcer is enabled.
  const say = useMemo(() => (text: string) => { if (enabled) void speak(text); }, [enabled, speak]);

  // ---- Incursions: nearest reachable one, fire-once-on-entry -----------------
  const incursionIds = useMemo(() => incursions.map((i) => i.systemId), [incursions]);
  const incRoutes = useRoute(currentSys, incursionIds, 'active');
  const nearestIncursion = useMemo(() => {
    let best: { jumps: number; name: string } | null = null;
    for (const [idStr, entry] of Object.entries(incRoutes)) {
      if (!incursionIds.includes(Number(idStr))) continue;
      if (!best || entry.jumps < best.jumps) {
        const last = entry.path[entry.path.length - 1];
        best = { jumps: entry.jumps, name: last?.name ?? '' };
      }
    }
    return best;
  }, [incRoutes, incursionIds]);
  const incInZone = useRef(false);
  useEffect(() => {
    const inZone = !!nearestIncursion && nearestIncursion.jumps <= threshold;
    if (inZone && !incInZone.current && nearestIncursion) {
      if (enabled && evIncur) {
        const { jumps, name } = nearestIncursion;
        say(jumps === 0 ? `Incursion in your system, ${name}.` : `Incursion ${jumpWord(jumps)} out, ${name}.`);
      }
      incInZone.current = true;
    } else if (!inZone) {
      incInZone.current = false;
    }
  }, [nearestIncursion, threshold, enabled, evIncur, say]);

  // ---- Lawless: nearest lowsec/nullsec via server BFS, fire-once-on-entry ----
  // Only when the pilot is in highsec (in LS/NS you're already in lawless). The
  // endpoint routes over stargates from the current k-space system.
  const nearestLawlessRef = useRef<NearbyLawless | null>(null);
  const lawlessInZone = useRef(false);
  useEffect(() => {
    if (!enabled || !evLawless || currentSys === null || !inHighsec) {
      lawlessInZone.current = false;
      nearestLawlessRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/systems/${currentSys}/nearby-lawless?jumps=${threshold}`), {
          credentials: 'include',
        });
        if (!res.ok || cancelled) return;
        const rows = (await res.json()) as NearbyLawless[];
        if (cancelled) return;
        const nearest = rows[0] ?? null;   // endpoint orders by jumps
        nearestLawlessRef.current = nearest;
        if (nearest && !lawlessInZone.current) {
          const kind = nearest.security > 0 ? 'Lowsec' : 'Nullsec';
          say(`${kind} ${jumpWord(nearest.jumps)} out, ${nearest.name}.`);
          lawlessInZone.current = true;
        } else if (!nearest) {
          lawlessInZone.current = false;
        }
      } catch { /* network hiccup — try again on next move */ }
    })();
    return () => { cancelled = true; };
  }, [currentSys, threshold, enabled, evLawless, inHighsec, say]);

  // ---- Kills: each new kill within threshold, seeded by id (no backlog) ------
  const killSysIds = useMemo(
    () => [...new Set(killLog.map((k) => k.eveSystemId))],
    [killLog],
  );
  const killRoutes = useRoute(currentSys, killSysIds, 'all');  // 'all' → chain kills route via wormholes
  const seenKills = useRef<Set<number> | null>(null);
  useEffect(() => {
    // Seed with whatever's already on screen so enabling doesn't replay history.
    if (seenKills.current === null) {
      seenKills.current = new Set(killLog.map((k) => k.killmailId));
      return;
    }
    if (!enabled || !evKills) return;
    for (const k of killLog) {
      if (seenKills.current.has(k.killmailId)) continue;
      seenKills.current.add(k.killmailId);
      const entry = killRoutes[String(k.eveSystemId)];
      if (!entry || entry.jumps > threshold) continue;
      const who = k.victimName ?? k.shipTypeName;
      say(entry.jumps === 0
        ? `Kill in your system, ${who} in ${k.systemName}.`
        : `Kill ${jumpWord(entry.jumps)} out, ${who} in ${k.systemName}.`);
    }
  }, [killLog, killRoutes, threshold, enabled, evKills, say]);

  // ---- Alt connect / disconnect across all your characters ------------------
  const prevOnline = useRef<Map<number, boolean> | null>(null);
  useEffect(() => {
    const cur = new Map<number, boolean>();
    for (const c of alts.byChar.values()) cur.set(c.charId, c.online);
    const prev = prevOnline.current;
    prevOnline.current = cur;
    if (prev === null) return;               // seed roster silently on first run
    if (!enabled || !evConnect) return;
    for (const c of alts.byChar.values()) {
      const was = prev.get(c.charId);
      if (was === undefined) continue;       // a newly-added character — seed, don't announce
      if (was === c.online) continue;
      say(c.online ? `${c.characterName} connected.` : `${c.characterName} disconnected.`);
    }
  }, [alts, enabled, evConnect, say]);

  // ---- New wormhole chain added by someone else (debounced) -----------------
  // chainAdds only counts REMOTE connection.add events (see remoteActivityStore).
  // Coalesce a burst of adds into one announcement.
  const prevChainAdds = useRef<number | null>(null);
  const chainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (prevChainAdds.current === null) { prevChainAdds.current = chainAdds; return; }
    if (chainAdds <= prevChainAdds.current) { prevChainAdds.current = chainAdds; return; }
    prevChainAdds.current = chainAdds;
    if (!enabled || !evChain) return;
    if (chainTimer.current) clearTimeout(chainTimer.current);
    chainTimer.current = setTimeout(() => {
      chainTimer.current = null;
      say('New connections added to the map.');
    }, 5000);
  }, [chainAdds, enabled, evChain, say]);
  useEffect(() => () => { if (chainTimer.current) clearTimeout(chainTimer.current); }, []);
}
