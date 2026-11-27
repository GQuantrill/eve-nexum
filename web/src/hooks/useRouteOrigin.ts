import { useShallow } from 'zustand/react/shallow';
import { useCharacterLocation } from './useCharacterLocation';
import { useAuth } from '../context/AuthContext';
import { useMapStore } from '../store/mapStore';
import { useUserSetting } from './useUserSetting';
import { KSPACE_CLASSES } from '../utils/routeActions';

export interface RouteOrigin {
  /** EVE system id to route FROM, or null when there's no usable origin. */
  systemId: number | null;
  /** True when the origin is a last known system (offline) rather than live. */
  fromLastKnown: boolean;
  /** Origin system name when known — for "jumps from X" labels. */
  name: string | null;
  /** Set when the origin is another of the account's characters (not the active one). */
  characterName: string | null;
  /** True when the origin is a map system picked with "Route from here". */
  pinnedSystem: boolean;
  /** True when routing starts in a wormhole (through the mapped chain). */
  inWormhole: boolean;
  /** Why there's no origin, when the pilot is somewhere we know but can't
   *  route from: in a wormhole with the chain option off, or (open-map scope)
   *  in a hole that isn't on the open map. */
  blocked: 'wormholeOptionOff' | 'notOnMap' | null;
  /** A picked origin (system or character) that couldn't be routed from, so
   *  the pilot's own location was used instead. Its name, for a note. */
  skipped: string | null;
}

interface Candidate {
  eveSystemId: number | null | undefined;
  systemClass: string | null | undefined;
}

/**
 * Resolves the system to calculate gate routes FROM, first that works of:
 *
 *  1. A map system picked with "Route from here".
 *  2. Another of the account's characters picked as the reference (e.g. a
 *     scout sitting on the chain exit).
 *  3. The active character's live ESI location when online.
 *  4. The active character's last known system (so jumps still work while
 *     logged out of EVE).
 *
 * A picked origin that can't be routed from falls through to the pilot's own
 * location, named in `skipped`, rather than leaving the pane empty.
 *
 * The origin must be somewhere the route graph can start FROM: any k-space
 * system, plus whatever the enabled routing overlays splice in:
 *   - Thera, when Thera scout connections are enabled.
 *   - A wormhole, when the wormhole-chain option is on and the hole is on a
 *     map the route will use: the open map for `scope` 'active', or any map
 *     the user can see for 'all' (the server unions those chains; a hole on
 *     none of them simply gets no routes).
 * (Turnur is ordinary low-sec and already qualifies as k-space.)
 */
export function useRouteOrigin(scope: 'active' | 'all' = 'active'): RouteOrigin {
  const pinned    = useMapStore((s) => s.routeFromSystem);
  const override  = useMapStore((s) => s.routeOrigin);
  const location  = useCharacterLocation();
  const lastKnown = useAuth().user?.lastKnownSystem ?? null;
  const [inclThera]     = useUserSetting<boolean>('nexum.route.includeThera', false);
  const [inclWormholes] = useUserSetting<boolean>('nexum.route.includeWormholes', false);
  const activeMapId = useMapStore((s) => s.activeMapId);
  // EVE ids of the systems on the active map — in 'active' scope a WH origin
  // only routes through the chain overlay if the hole is one of these nodes.
  const mapEveIds = useMapStore(
    useShallow((s) => new Set(s.map.systems.map((x) => x.eveSystemId).filter((v): v is number => v != null))),
  );

  const isKspace = (c: Candidate) => !!c.systemClass && KSPACE_CLASSES.has(c.systemClass);
  /** null when routable, else why not. */
  const check = (c: Candidate): RouteOrigin['blocked'] | 'unknown' | null => {
    if (c.eveSystemId == null) return 'unknown';
    if (isKspace(c)) return null;
    if (c.systemClass === 'Thera' && inclThera) return null;
    if (!inclWormholes) return 'wormholeOptionOff';
    if (scope === 'all') return null;
    return activeMapId && mapEveIds.has(c.eveSystemId) ? null : 'notOnMap';
  };

  const base = { fromLastKnown: false, characterName: null, pinnedSystem: false, blocked: null, skipped: null };
  let skipped: string | null = null;

  if (pinned) {
    if (check(pinned) === null) {
      return { ...base, systemId: pinned.eveSystemId, name: pinned.systemName, pinnedSystem: true, inWormhole: !isKspace(pinned) };
    }
    skipped = pinned.systemName;
  }
  if (override) {
    if (check(override) === null) {
      return { ...base, systemId: override.eveSystemId, name: override.systemName, characterName: override.characterName,
        inWormhole: !isKspace(override), skipped };
    }
    skipped ??= override.characterName;
  }

  let blocked: RouteOrigin['blocked'] = null;
  if (location.online && location.system) {
    const live = { eveSystemId: location.system.eveSystemId, systemClass: location.system.systemClass };
    const why = check(live);
    if (why === null) {
      return { ...base, systemId: live.eveSystemId, name: location.system.name, inWormhole: !isKspace(live), skipped };
    }
    // Online somewhere we can't route from: keep why, for the message if the
    // last known system doesn't work either.
    if (why !== 'unknown') blocked = why;
  }
  if (lastKnown?.id != null) {
    const last = { eveSystemId: lastKnown.id, systemClass: lastKnown.systemClass };
    const why = check(last);
    if (why === null) {
      return { ...base, systemId: last.eveSystemId, fromLastKnown: true, name: lastKnown.name, inWormhole: !isKspace(last), skipped };
    }
    if (why !== 'unknown') blocked ??= why;
  }
  return { ...base, systemId: null, name: null, inWormhole: false, blocked, skipped };
}
