import { useCharacterLocation } from './useCharacterLocation';
import { useAuth } from '../context/AuthContext';
import { KSPACE_CLASSES } from '../components/ui/routeUi';

export interface RouteOrigin {
  /** EVE system id to route FROM, or null when there's no usable origin. */
  systemId: number | null;
  /** True when the origin is the pilot's last known system (offline) rather than live. */
  fromLastKnown: boolean;
  /** Origin system name when known — for "jumps from X" labels. */
  name: string | null;
}

/**
 * Resolves the system to calculate gate routes FROM, with a graceful offline
 * fallback. When the pilot is online and docked/floating in k-space we use
 * their live ESI location; otherwise we fall back to their last known system
 * (from /auth/me) so jump counts still work while they're logged out of EVE.
 *
 * Either way the origin must be k-space — gate routing can't start inside a
 * wormhole — so a last known WH system yields no origin (callers show the
 * usual sign-in/dock prompt).
 */
export function useRouteOrigin(): RouteOrigin {
  const location  = useCharacterLocation();
  const lastKnown = useAuth().user?.lastKnownSystem ?? null;

  if (location.online && location.system && KSPACE_CLASSES.has(location.system.systemClass)) {
    return { systemId: location.system.eveSystemId, fromLastKnown: false, name: location.system.name };
  }
  if (lastKnown?.id != null && lastKnown.systemClass && KSPACE_CLASSES.has(lastKnown.systemClass)) {
    return { systemId: lastKnown.id, fromLastKnown: true, name: lastKnown.name };
  }
  return { systemId: null, fromLastKnown: false, name: null };
}
