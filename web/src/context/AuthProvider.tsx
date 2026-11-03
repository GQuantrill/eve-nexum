import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, setUnauthorizedHandler } from '../api/client';
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

  // The startup check. Only an answer from the server decides "not logged in":
  // /auth/me says so with { user: null } (or a 401). A failed request -- the
  // server slow to answer, a proxy timeout page, the network -- says nothing
  // about the session, so it's retried rather than dropping a pilot whose
  // session is fine onto the login page. Backs off to every 15s, and tells
  // them once that it's still trying.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const check = () => {
      api<{ user: AuthUser | null }>('/auth/me')
        .then((d) => {
          if (cancelled) return;
          setUser(d.user);
          if (d.user) {
            localStorage.setItem('nexum.last_character', JSON.stringify({
              characterId:   d.user.characterId,
              characterName: d.user.characterName,
            }));
          }
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 401) { setUser(null); setLoading(false); return; }
          if (attempt === 1) toast.info(i18n.t('session.reconnecting'));
          timer = setTimeout(check, Math.min(15_000, 2_000 * 2 ** attempt));
          attempt += 1;
        });
    };
    check();
    return () => { cancelled = true; clearTimeout(timer); };
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
