import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCharacterLocation } from './useCharacterLocation';

/**
 * Re-read the account when the character goes offline, so the last-known
 * location stops being the one from page load.
 *
 * /auth/me is fetched once on mount, so user.lastKnownSystem is frozen at
 * whenever the tab was opened. While the character is online nothing notices —
 * the live location drives everything. The moment they log off, every consumer
 * falls back to that frozen value, which by then can be hours and a dozen
 * jumps out of date. The server has the right answer the whole time: the
 * location poll has been writing each jump to last_known_system_id.
 *
 * So this watches for the online -> offline edge and pulls once. Only on the
 * edge, not on a timer and not while offline, because the value cannot change
 * again until the character comes back.
 */
export function useRefreshLastKnown(): void {
  const { online } = useCharacterLocation();
  const { refresh, user } = useAuth();
  const wasOnline = useRef(false);

  useEffect(() => {
    // Nothing to do until we have actually seen them online this session —
    // otherwise a tab opened while they are logged out would fire on mount for
    // a value that is already current.
    if (online) { wasOnline.current = true; return; }
    if (!wasOnline.current || !user) return;
    wasOnline.current = false;
    void refresh();
  }, [online, refresh, user]);
}
