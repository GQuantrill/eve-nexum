import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from '../api/client';
import { toast } from '../components/ui/Toaster';
import i18n from '../i18n';

// Role tiers, low to high: readonly < edit < full < admin < alliance_admin.
export type Role = 'alliance_admin' | 'admin' | 'full' | 'edit' | 'readonly';

/** True for corp admin OR alliance admin — every admin capability. */
export function isAdminRole(role: Role): boolean {
  return role === 'admin' || role === 'alliance_admin';
}
/** True only for the alliance admin tier. */
export function isAllianceAdminRole(role: Role): boolean {
  return role === 'alliance_admin';
}

// The canonical role order (highest tier first), for pickers and the roles
// explainer. `readonly` is the default for a new member.
export const ROLE_ORDER: Role[] = ['alliance_admin', 'admin', 'full', 'edit', 'readonly'];

/** Human display label for a role id: 'alliance_admin' -> 'Alliance admin'. */
export function formatRole(role: Role): string {
  const spaced = role.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface LastKnownSystem {
  id: number;
  name: string | null;
  systemClass: string | null;
  at: string | null;
}

// A character linked to the same account (owner), for the character switcher.
export interface AccountCharacter {
  id: number;                 // users.id
  characterId: number;        // EVE character id (for the portrait)
  characterName: string;
  role: Role;
  corpId: number | null;
  blocked: boolean;
  lastKnownSystemId: number | null;
  lastKnownSystemName: string | null;
  lastKnownSystemClass: string | null;
  active: boolean;
}

export interface AuthUser {
  id: number;
  characterId: number;
  characterName: string;
  role: Role;
  corpMode: boolean;
  allianceMode: boolean;
  /** Account (human) this character belongs to; groups all linked alts. */
  ownerId: number | null;
  /** Every character linked to this account, for the switcher. */
  characters: AccountCharacter[];
  /** Where the pilot was last seen (updated as they jump). null until first ESI poll. */
  lastKnownSystem: LastKnownSystem | null;
  compactMode: boolean;
  snapToGrid: boolean;
  showMinimap: boolean;
  uniformSize: boolean;
  showStatics: boolean;
  easyConnect: boolean;
  connectionThickness: string;
  routeMode: string;
  uiZoom: number;
  uiSettings: Record<string, unknown>;
  panelOrder: string[];
  canViewReports: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** Idle-lock: the session is still valid, the UI is just paused. */
  locked: boolean;
  lock: () => void;
  unlock: () => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  locked: false,
  lock: () => {},
  unlock: () => {},
  logout: async () => {},
  refresh: async () => {},
});

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

export const useAuth = () => useContext(AuthContext);
