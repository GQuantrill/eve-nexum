import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';

// 30 s — this only drives the online/offline dot and its tooltip. It deliberately
// does NOT feed the toolbar's "checked X ago" indicator: that sits beside the
// system name and must age the 10 s location poll (see useCharacterLocation).
const POLL_MS = 30_000;

interface OnlineStatus {
  online:    boolean | null;
  /** TQ session start as reported by ESI. Set when online === true; the
   *  toolbar surfaces it in the tooltip so orphan sessions (still "online"
   *  hours after the user crashed out) are visible at a glance. */
  lastLogin: string | null;
}

export function useOnlineStatus(enabled: boolean): OnlineStatus {
  const [online, setOnline]         = useState<boolean | null>(null);
  const [lastLogin, setLastLogin]   = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await api<{ online: boolean | null; scopeMissing?: boolean; lastLogin?: string | null }>('/api/character/online');
      setOnline(data.scopeMissing ? null : data.online);
      setLastLogin(data.lastLogin ?? null);
    } catch {
      setOnline(null);
      setLastLogin(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    check();
    const id = setInterval(check, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, check]);

  return { online, lastLogin };
}
