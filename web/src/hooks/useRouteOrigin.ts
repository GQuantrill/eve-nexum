import { useCharacterLocation } from './useCharacterLocation';
import { useAuth } from '../context/AuthContext';
import { useMapStore } from '../store/mapStore';
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
 * The origin must be k-space — gate routing can't start inside a wormhole — so a
 * WH origin yields none (callers show the usual sign-in/dock prompt).
 */
export function useRouteOrigin(): RouteOrigin {
  const override  = useMapStore((s) => s.routeOrigin);
  const location  = useCharacterLocation();
  const lastKnown = useAuth().user?.lastKnownSystem ?? null;

  if (override) {
    if (override.systemClass && KSPACE_CLASSES.has(override.systemClass)) {
      return { systemId: override.eveSystemId, fromLastKnown: false, name: override.systemName, characterName: override.characterName };
    }
    return { systemId: null, fromLastKnown: false, name: override.systemName, characterName: override.characterName };
  }

  if (location.online && location.system && KSPACE_CLASSES.has(location.system.systemClass)) {
    return { systemId: location.system.eveSystemId, fromLastKnown: false, name: location.system.name, characterName: null };
  }
  if (lastKnown?.id != null && lastKnown.systemClass && KSPACE_CLASSES.has(lastKnown.systemClass)) {
    return { systemId: lastKnown.id, fromLastKnown: true, name: lastKnown.name, characterName: null };
  }
  return { systemId: null, fromLastKnown: false, name: null, characterName: null };
}
