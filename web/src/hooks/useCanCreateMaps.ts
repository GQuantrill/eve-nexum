import { useAuth, isAdminRole, isAllianceAdminRole } from '../context/AuthContext';

// True when the current user is allowed to create / delete / lock maps. The
// 'edit' role can mutate map contents but cannot manage map lifecycle —
// keeping that as a separate permission lets corps grant edit access broadly
// without letting everyone delete shared chains. The server enforces this on
// every write; this hook just hides the buttons.
export function useCanCreateMaps(): boolean {
  const user = useAuth().user;
  if (!user) return false;
  return isAdminRole(user.role) || user.role === 'full';
}

// True when the user can create / manage ALLIANCE-scoped maps — the alliance
// admin tier only, and only in an alliance-mode deployment.
export function useCanManageAllianceMaps(): boolean {
  const user = useAuth().user;
  if (!user) return false;
  return user.allianceMode && isAllianceAdminRole(user.role);
}
