import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { pilotOnline, subscribePilotActivity } from './pilotActivity';

// The online/offline dot beside the portrait.
//
// This used to poll /api/character/online every 30s for a boolean the LOCATION
// poll already returns on every tick — the same field that feeds pilotActivity.
// So the flag now comes from there: one fewer request a minute, and the dot
// reacts on the 10s location cadence instead of its own slower 30s one.
//
// What the location endpoint cannot tell us is WHY a character reads as
// offline. It degrades a revoked or unscoped token to `{ online: false }`,
// while /online distinguishes that case and answers `scopeMissing`. Reporting a
// confident "offline" for someone who simply never granted the scope would be
// the dot stating something untrue, so /online is still called — just not on a
// timer:
//   - once on mount, to learn scopeMissing and the session-start timestamp;
//   - again when the pilot comes back online, since lastLogin only changes then.
const OFFLINE_DOT: boolean | null = null;

interface OnlineStatus {
  online:    boolean | null;
  /** TQ session start as reported by ESI. Set when online === true; the
   *  toolbar surfaces it in the tooltip so orphan sessions (still "online"
   *  hours after the user crashed out) are visible at a glance. */
  lastLogin: string | null;
}

export function useOnlineStatus(enabled: boolean): OnlineStatus {
  const [lastLogin, setLastLogin]       = useState<string | null>(null);
  const [scopeMissing, setScopeMissing] = useState(false);

  // Live flag, straight off the location poll.
  const derived = useSyncExternalStore(subscribePilotActivity, pilotOnline, () => OFFLINE_DOT);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await api<{ online: boolean | null; scopeMissing?: boolean; lastLogin?: string | null }>(
        '/api/character/online',
      );
      setScopeMissing(!!data.scopeMissing);
      setLastLogin(data.lastLogin ?? null);
    } catch {
      setScopeMissing(false);
      setLastLogin(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    // Deliberate: the one-off mount read that establishes scopeMissing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [enabled, refresh]);

  // lastLogin changes only when a session starts, so re-read it on the
  // transition into online rather than on a clock.
  const wasOnline = useRef<boolean | null>(null);
  useEffect(() => {
    const came = wasOnline.current !== true && derived === true;
    wasOnline.current = derived;
    if (came && enabled) void refresh();
  }, [derived, enabled, refresh]);

  // A missing scope means we genuinely cannot tell — never let the location
  // poll's `false` harden that into "offline".
  return { online: scopeMissing ? null : derived, lastLogin };
}
