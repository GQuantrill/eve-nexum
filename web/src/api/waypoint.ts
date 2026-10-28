import { api } from './client';
import { toast } from '../utils/toastStore';
import i18n from '../i18n';
import { readUserSetting } from '../hooks/useUserSetting';

// Who a Set Destination / Add Waypoint goes to by default: just the character
// you're signed in as, or every character on the account that's logged in.
export const WAYPOINT_SEND_TO_KEY = 'nexum.waypoint.sendTo';
export type WaypointSendTo = 'me' | 'allOnline';

/** The account characters to send to: 'allOnline', or a chosen list of users.id. */
export type WaypointTargets = 'allOnline' | number[];

export interface WaypointResult {
  charId:        number;
  characterId:   number;
  characterName: string;
  status:        'ok' | 'offline' | 'no_scope' | 'token_expired' | 'esi_error';
}

/**
 * Toast copy for a multi-character send: what went where, and who it couldn't
 * reach and why. `ok` is how many got it.
 */
export function describeWaypointResults(
  results: WaypointResult[], clear: boolean, systemName: string,
): { ok: number; success: string | null; problems: string | null } {
  const t = i18n.t.bind(i18n);
  const sent = results.filter((r) => r.status === 'ok');
  const missed = results.filter((r) => r.status !== 'ok');
  const success = sent.length === 0 ? null
    : t(clear ? 'routeToast.destinationSetFor' : 'routeToast.waypointAddedFor', {
        system: systemName, count: sent.length,
      });
  const problems = missed.length === 0 ? null
    : t(sent.length === 0 ? 'routeToast.noneSent' : 'routeToast.notSentTo', {
        list: missed.map((r) => `${r.characterName} (${t(`routeToast.reason.${r.status}` as 'routeToast.reason.offline')})`).join(', '),
      });
  return { ok: sent.length, success, problems };
}

// Fire the ESI waypoint endpoint and surface the outcome via toast. On success
// we name the target ("Destination set to X" / "X successfully added to
// waypoints"); on failure we point at the likely cause (the character must be
// online in-game). The promise still rejects so callers can react further
// (e.g. flash a status), but the toast is the user-facing feedback.
//
// With targets (or the "all online characters" setting) it goes to several of
// the account's characters at once and rejects only if none of them got it.
function post(destinationId: number, clearOtherWaypoints: boolean, systemName: string, targets?: WaypointTargets) {
  const to = targets
    ?? (readUserSetting<WaypointSendTo>(WAYPOINT_SEND_TO_KEY, 'me') === 'allOnline' ? 'allOnline' : undefined);

  if (to === undefined) {
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

  return api<{ results: WaypointResult[] }>('/api/character/waypoint', {
    method: 'POST',
    body: JSON.stringify({ destinationId, clearOtherWaypoints, addToBeginning: false, to }),
  })
    .then(({ results }) => {
      const { ok, success, problems } = describeWaypointResults(results, clearOtherWaypoints, systemName);
      if (success) toast.success(success);
      if (problems) (ok === 0 ? toast.error : toast.info)(problems);
      if (ok === 0) throw new Error('No character received the waypoint');
    }, (err) => {
      toast.error(i18n.t('routeToast.failed'));
      throw err;
    });
}

export function setDestination(destinationId: number, systemName: string, targets?: WaypointTargets) {
  return post(destinationId, true, systemName, targets);
}

export function addWaypoint(destinationId: number, systemName: string, targets?: WaypointTargets) {
  return post(destinationId, false, systemName, targets);
}
