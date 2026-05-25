import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';

const POLL_MS = 30_000;

interface OnlineStatus {
  online:    boolean | null;
  checkedAt: Date | null;
  /** TQ session start as reported by ESI. Set when online === true; the
   *  toolbar surfaces it in the tooltip so orphan sessions (still "online"
   *  hours after the user crashed out) are visible at a glance. */
  lastLogin: string | null;
}

export function useOnlineStatus(enabled: boolean): OnlineStatus {
  const [online, setOnline]         = useState<boolean | null>(null);
  const [checkedAt, setCheckedAt]   = useState<Date | null>(null);
  const [lastLogin, setLastLogin]   = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await api<{ online: boolean | null; scopeMissing?: boolean; lastLogin?: string | null }>('/api/character/online');
      setOnline(data.scopeMissing ? null : data.online);
      setLastLogin(data.lastLogin ?? null);
      setCheckedAt(new Date());
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

  return { online, checkedAt, lastLogin };
}
