import { useMapStore } from '../store/mapStore';
import { useAuth, isAllianceAdminRole } from '../context/AuthContext';

/**
 * True when the current user owns (or co-owns via corp membership) the
 * active map — i.e. it isn't reaching them via a `map_shares` grant.
 *
 * Use this to gate owner-only UI (rename, delete, manage share grants,
 * generate public share links). Edit-level access for shared recipients
 * is governed by [[useCanEdit]] instead — they can edit content + topology
 * but not perform map-lifecycle operations.
 *
 * Alliance maps are the exception: they have no single owner, so management
 * rights (rename / delete / share) belong to the alliance admin tier rather
 * than to every alliance member.
 */
export function useIsMapOwner(): boolean {
  const activeMapId = useMapStore((s) => s.activeMapId);
  const maps        = useMapStore((s) => s.maps);
  const user        = useAuth().user;
  if (!activeMapId) return false;
  const active = maps.find((m) => m.id === activeMapId);
  if (!active) return false;
  if (active.isAllianceMap) return !!user && isAllianceAdminRole(user.role);
  return !active.sharedWithMe;
}
