import { useAuth } from '../context/AuthContext';
import { useMapStore } from '../store/mapStore';

// True when the current user is allowed to mutate the active map. The server
// enforces this on every write — this hook just hides UI that would always
// 403. On personal maps the user is always the owner; on corp maps members /
// admins can write, readonly cannot. A locked map disables everyone except
// admins.
export function useCanEdit(): boolean {
  const user      = useAuth().user;
  const isCorpMap = useMapStore((s) => !!s.map.isCorpMap);
  const locked    = useMapStore((s) => !!s.map.locked);

  if (!user) return false;
  if (locked && user.role !== 'admin') return false;
  if (!isCorpMap) return true;
  return user.role === 'admin' || user.role === 'member';
}
