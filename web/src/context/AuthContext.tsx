import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

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
  role: 'admin' | 'full' | 'edit' | 'readonly';
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
  role: 'admin' | 'full' | 'edit' | 'readonly';
  corpMode: boolean;
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
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

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
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  // Memoize so consumers don't re-render every time AuthProvider re-renders
  // for an unrelated reason. logout is stable via useCallback.
  const value = useMemo(() => ({ user, loading, logout }), [user, loading, logout]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
