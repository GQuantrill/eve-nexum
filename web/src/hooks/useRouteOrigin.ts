import { useShallow } from 'zustand/react/shallow';
import { useCharacterLocation } from './useCharacterLocation';
import { useAuth } from '../context/AuthContext';
import { useMapStore } from '../store/mapStore';
import { useUserSetting } from './useUserSetting';
import { KSPACE_CLASSES } from '../components/ui/routeUi';

export interface RouteOrigin {
  /** EVE system id to route FROM, or null when there's no usable origin. */
  systemId: number | null;
  /** True when the origin is a last known system (offline) rather than live. */
  fromLastKnown: boolean;
  /** Origin system name when known — for "jumps from X" labels. */
  name: string | null;
  /** Set when the origin is another of the account's characters (not the active one). */
  characterName: string | null;
}

/**
 * Resolves the system to calculate gate routes FROM, with graceful fallbacks:
 *
 *  1. An explicit route-origin override — another of the account's characters
 *     (e.g. a scout sitting on the chain exit) selected as the reference.
 *  2. Otherwise the active character's live ESI location when online in k-space.
 *  3. Otherwise the active character's last known system (so jumps still work
 *     while logged out of EVE).
 *
 * The origin must be somewhere the route graph can start FROM. That's any
 * k-space system, plus whatever the enabled routing overlays splice into the
 * graph:
 *   - Thera, when Thera scout connections are enabled (its exits become edges).
 *   - Any wormhole that's on the ACTIVE map, when the wormhole-chain option is
 *     enabled — the overlay adds the map's connections, so the hole you're
 *     actually mapping becomes a valid source even though J-space has no gates.
 * (Turnur is ordinary low-sec and already qualifies as k-space.) An origin the
 * graph can't reach yields none, so callers show the usual sign-in/dock prompt.
 */
export function useRouteOrigin(): RouteOrigin {
  const override  = useMapStore((s) => s.routeOrigin);
  const location  = useCharacterLocation();
  const lastKnown = useAuth().user?.lastKnownSystem ?? null;
  const [inclThera]     = useUserSetting<boolean>('nexum.route.includeThera', false);
  const [inclWormholes] = useUserSetting<boolean>('nexum.route.includeWormholes', false);
  const activeMapId = useMapStore((s) => s.activeMapId);
  // EVE ids of the systems on the active map — a WH origin only routes through
  // the chain overlay if the hole is actually one of these nodes.
  const mapEveIds = useMapStore(
    useShallow((s) => new Set(s.map.systems.map((x) => x.eveSystemId).filter((v): v is number => v != null))),
  );

  const canOriginate = (systemClass: string | null | undefined, eveSystemId: number | null | undefined): boolean => {
    if (systemClass && KSPACE_CLASSES.has(systemClass)) return true;
    if (systemClass === 'Thera' && inclThera) return true;
    if (inclWormholes && !!activeMapId && eveSystemId != null && mapEveIds.has(eveSystemId)) return true;
    return false;
  };

  if (override) {
    if (canOriginate(override.systemClass, override.eveSystemId)) {
      return { systemId: override.eveSystemId, fromLastKnown: false, name: override.systemName, characterName: override.characterName };
    }
    return { systemId: null, fromLastKnown: false, name: override.systemName, characterName: override.characterName };
  }

  if (location.online && location.system && canOriginate(location.system.systemClass, location.system.eveSystemId)) {
    return { systemId: location.system.eveSystemId, fromLastKnown: false, name: location.system.name, characterName: null };
  }
  if (lastKnown?.id != null && canOriginate(lastKnown.systemClass, lastKnown.id)) {
    return { systemId: lastKnown.id, fromLastKnown: true, name: lastKnown.name, characterName: null };
  }
  return { systemId: null, fromLastKnown: false, name: null, characterName: null };
}
