import { createContext, useContext } from 'react';

// Role tiers, low to high: readonly < edit < full < admin < alliance_admin.
export type Role = 'alliance_admin' | 'admin' | 'full' | 'edit' | 'contributor' | 'readonly';

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
export const ROLE_ORDER: Role[] = ['alliance_admin', 'admin', 'full', 'edit', 'contributor', 'readonly'];

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
  /** External read API (/api/v1) is switched off — the UI disables API-key creation. */
  externalApiDisabled?: boolean;
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

// Exported so AuthProvider (its own module, so this file stays free of
// components and Fast Refresh keeps working for both) can supply it.
export const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  locked: false,
  lock: () => {},
  unlock: () => {},
  logout: async () => {},
  refresh: async () => {},
});


export const useAuth = () => useContext(AuthContext);
