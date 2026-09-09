import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from '../api/client';
import { toast } from '../utils/toastStore';
import i18n from '../i18n';
import { AuthContext, type AuthUser } from './AuthContext';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  // Idle-lock pauses the UI without ending the session — clicking "Continue"
  // resumes instantly, no SSO round-trip. Cleared on real logout / no session.
  const [locked, setLocked] = useState(false);
  const lock = useCallback(() => setLocked(true), []);
  const unlock = useCallback(() => setLocked(false), []);

  // Kick back to login when a request 401s (session revoked / expired). Guarded
  // so it only fires when we currently believe we're logged in — an
  // unauthenticated /auth/me probe (userRef null) is ignored — and only once
  // per session, since a dropped session 401s many in-flight requests at once.
  const userRef  = useRef<AuthUser | null>(null);
  const kickedRef = useRef(false);
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!userRef.current || kickedRef.current) return;
      kickedRef.current = true;
      setLocked(false);
      setUser(null);
      toast.info(i18n.t('session.ended'));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    api<{ user: AuthUser | null }>('/auth/me')
      .then((d) => {
        setUser(d.user);
        if (d.user) {
          localStorage.setItem('nexum.last_character', JSON.stringify({
            characterId:   d.user.characterId,
            characterName: d.user.characterName,
          }));
        }
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const logout = useCallback(async () => {
    setLocked(false);
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  // Re-pull /auth/me without a full reload — e.g. after the character list
  // changes (linking handled via redirect; removal stays in-page).
  const refresh = useCallback(async () => {
    try {
      const d = await api<{ user: AuthUser | null }>('/auth/me');
      setUser(d.user);
    } catch { /* keep the current user on a transient failure */ }
  }, []);

  // Mirror `user` into the ref the 401 handler reads, and re-arm the one-shot
  // kick guard whenever a session (re-)establishes.
  useEffect(() => {
    userRef.current = user;
    if (user) kickedRef.current = false;
  }, [user]);

  // Memoize so consumers don't re-render every time AuthProvider re-renders
  // for an unrelated reason. logout / refresh are stable via useCallback.
  const value = useMemo(
    () => ({ user, loading, locked, lock, unlock, logout, refresh }),
    [user, loading, locked, lock, unlock, logout, refresh],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
