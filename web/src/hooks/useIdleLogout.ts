import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { toast } from '../components/ui/Toaster';
import i18n from '../i18n';

// Sign the pilot out after this long with no interaction. Long-lived sessions
// otherwise keep "last login" stale (we never kick anyone) — an idle gap forces
// a fresh SSO login, and last_login_at, when they come back.
const IDLE_LOGOUT_MS = 30 * 60 * 1000;
const CHECK_MS       = 30 * 1000;   // how often we test for idleness
const WRITE_THROTTLE = 5 * 1000;    // min gap between activity timestamp writes

// Any of these counts as "interacting". Stamped to localStorage so activity in
// ANY open tab keeps every tab alive — a backgrounded idle tab won't sign you
// out while you're working in another.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'mousemove', 'touchstart', 'scroll'] as const;
const KEY = 'nexum.lastActivity';

export function useIdleLogout(enabled: boolean): void {
  const { logout } = useAuth();

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
      if (Date.now() - last < IDLE_LOGOUT_MS) return;
      window.clearInterval(id);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, bump));
      toast.info(i18n.t('session.idleLogout'));
      void logout();
    }, CHECK_MS);

    return () => {
      window.clearInterval(id);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [enabled, logout]);
}
