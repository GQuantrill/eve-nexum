import { useAuth, isAdminRole } from '../context/AuthContext';
import { useMapStore } from '../store/mapStore';

// True when the current user is allowed to mutate the active map. The server
// enforces this on every write — this hook just hides UI that would always 403.
// Mirrors the server's requireMapContentWrite:
//   • the map's OWNER always edits it;
//   • any other access (corp/alliance member OR a share recipient) is bound by
//     the caller's role — 'readonly' can view but never edit, even on an
//     edit-share;
//   • a view-only share (shareCanWrite === false) caps editing regardless of
//     role;
//   • a locked map disables everyone except admins (corp or alliance).
export function useCanEdit(): boolean {
  const user          = useAuth().user;
  const isCorpMap     = useMapStore((s) => !!s.map.isCorpMap);
  const isAllianceMap = useMapStore((s) => !!s.map.isAllianceMap);
  const locked        = useMapStore((s) => !!s.map.locked);
  const accessKind    = useMapStore((s) => s.map.accessKind);
  const shareCanWrite = useMapStore((s) => s.map.shareCanWrite);

  if (!user) return false;
  if (locked && !isAdminRole(user.role)) return false;

  // View-only share: never editable, whatever the role.
  if (accessKind === 'shared' && shareCanWrite === false) return false;
  // The map owner always edits their own map.
  if (accessKind === 'owner') return true;
  // Fallback for a map loaded without accessKind (older payload): a personal
  // map is the caller's own, so editable.
  if (accessKind === undefined && !isCorpMap && !isAllianceMap) return true;

  // Everyone else (member or edit-share recipient) is role-gated: 'edit',
  // 'full', 'admin', 'alliance_admin' may write; 'readonly' may not.
  return isAdminRole(user.role) || user.role === 'full' || user.role === 'edit';
}
