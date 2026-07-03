import { useAuth, isAdminRole } from '../context/AuthContext';
import { useMapStore } from '../store/mapStore';

// Looser sibling of useCanEdit: returns true for write access *ignoring*
// the per-map locked flag. Used by the signature/structure/notes UIs, which
// stay live even when an admin has locked the map's topology. Topology
// changes (system add/move/delete, connection edits) still go through
// useCanEdit and remain blocked.
export function useCanEditContent(): boolean {
  const user          = useAuth().user;
  const isCorpMap     = useMapStore((s) => !!s.map.isCorpMap);
  const isAllianceMap = useMapStore((s) => !!s.map.isAllianceMap);

  if (!user) return false;
  if (!isCorpMap && !isAllianceMap) return true;
  return isAdminRole(user.role) || user.role === 'full' || user.role === 'edit';
}
