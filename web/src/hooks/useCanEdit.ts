import { useAuth, isAdminRole } from '../context/AuthContext';
import { useMapStore } from '../store/mapStore';

// True when the current user is allowed to mutate the active map. The server
// enforces this on every write — this hook just hides UI that would always
// 403. On personal maps the user is always the owner; on corp/alliance maps
// members / admins can write, readonly cannot. A locked map disables everyone
// except admins (corp or alliance).
export function useCanEdit(): boolean {
  const user          = useAuth().user;
  const isCorpMap     = useMapStore((s) => !!s.map.isCorpMap);
  const isAllianceMap = useMapStore((s) => !!s.map.isAllianceMap);
  const locked        = useMapStore((s) => !!s.map.locked);

  if (!user) return false;
  if (locked && !isAdminRole(user.role)) return false;
  if (!isCorpMap && !isAllianceMap) return true;
  // 'edit', 'full', 'admin' and 'alliance_admin' can write to shared maps.
  return isAdminRole(user.role) || user.role === 'full' || user.role === 'edit';
}
