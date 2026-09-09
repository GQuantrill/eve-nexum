import { api } from '../api/client';
import { toast } from './toastStore';
import i18n from '../i18n';
import type { RouteEntry } from '../hooks/useRoute';

/**
 * Route actions and constants, split out of components/ui/routeUi so that file
 * exports only components (Fast Refresh needs that) — and so the non-visual
 * bits can be used without pulling a component in.
 */

/**
 * Whether the route's destination can be pushed to the in-game autopilot.
 *
 * A k-space destination always can — EVE routes there via stargates even when
 * the shortest *displayed* route shortcuts through a wormhole, a Thera/Turnur
 * hole, or an Ansiblex bridge. The autopilot only needs the target itself to be
 * gate-reachable; it computes its own gate path and ignores the shortcut. So
 * the button is gated on the DESTINATION being k-space, never on whether the
 * path happened to use a shortcut. Only a J-space (wormhole) destination, which
 * has no gates, genuinely can't be an autopilot waypoint.
 *
 * Defaults to true when there's no computed route — the target is still a real
 * system the user can autopilot toward.
 */
export function canSetAutopilot(route?: RouteEntry): boolean {
  const dest = route?.path[route.path.length - 1];
  return dest ? dest.kspace : true;
}

/** Fire ESI waypoint endpoint; surface success/failure via toast. */
export function setWaypoint(systemId: number, systemName: string, clear: boolean) {
  api('/api/character/waypoint', {
    method: 'POST',
    body:   JSON.stringify({ destinationId: systemId, clearOtherWaypoints: clear }),
  })
    .then(() => toast.success(clear
      ? i18n.t('routeToast.destinationSet', { system: systemName })
      : i18n.t('routeToast.waypointAdded', { system: systemName })))
    .catch(() => toast.error(i18n.t('routeToast.failed')));
}

/** K-space classes from which a stargate route can be computed. */
export const KSPACE_CLASSES = new Set(['HS', 'LS', 'NS', 'Pochven']);
