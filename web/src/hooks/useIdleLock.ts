import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

// Pause the UI (idle-lock) after this long with no interaction. Unlike a full
// logout, the session stays valid — the lock screen's "Continue" resumes
// instantly with no SSO round-trip. While locked the map unmounts, so its ESI
// polling stops too (see useCharacterLocation's subscriber count).
const IDLE_LOCK_MS   = 30 * 60 * 1000;
const CHECK_MS       = 30 * 1000;   // how often we test for idleness
const WRITE_THROTTLE = 5 * 1000;    // min gap between activity timestamp writes

// Any of these counts as "interacting". Stamped to localStorage so activity in
// ANY open tab keeps every tab alive — a backgrounded idle tab won't lock while
// you're working in another.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'mousemove', 'touchstart', 'scroll'] as const;
const KEY = 'nexum.lastActivity';

export function useIdleLock(enabled: boolean): void {
  const { lock } = useAuth();

  useEffect(() => {
    if (!enabled) return;

    const stamp = (t: number) => { try { localStorage.setItem(KEY, String(t)); } catch { /* private mode */ } };
    const read  = (): number => { try { return parseInt(localStorage.getItem(KEY) ?? '', 10) || 0; } catch { return 0; } };

    let lastWrite = 0;
    const bump = () => {
      const now = Date.now();
      if (now - lastWrite < WRITE_THROTTLE) return;  // mousemove/scroll are noisy
      lastWrite = now;
      stamp(now);
    };

    stamp(Date.now());  // arriving here is itself activity
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    const id = window.setInterval(() => {
      const last = read() || Date.now();
      if (Date.now() - last < IDLE_LOCK_MS) return;
      window.clearInterval(id);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, bump));
      lock();
    }, CHECK_MS);

    return () => {
      window.clearInterval(id);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [enabled, lock]);
}
