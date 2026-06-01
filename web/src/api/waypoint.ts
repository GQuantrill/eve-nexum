import { api } from './client';
import { toast } from '../components/ui/Toaster';
import i18n from '../i18n';

// Fire the ESI waypoint endpoint and surface the outcome via toast. On success
// we name the target ("Destination set to X" / "X successfully added to
// waypoints"); on failure we point at the likely cause (the character must be
// online in-game). The promise still rejects so callers can react further
// (e.g. flash a status), but the toast is the user-facing feedback.
function post(destinationId: number, clearOtherWaypoints: boolean, systemName: string) {
  return api('/api/character/waypoint', {
    method: 'POST',
    body: JSON.stringify({ destinationId, clearOtherWaypoints, addToBeginning: false }),
  })
    .then(() => {
      toast.success(clearOtherWaypoints
        ? i18n.t('routeToast.destinationSet', { system: systemName })
        : i18n.t('routeToast.waypointAdded', { system: systemName }));
    })
    .catch((err) => {
      toast.error(i18n.t('routeToast.failed'));
      throw err;
    });
}

export function setDestination(destinationId: number, systemName: string) {
  return post(destinationId, true, systemName);
}

export function addWaypoint(destinationId: number, systemName: string) {
  return post(destinationId, false, systemName);
}
