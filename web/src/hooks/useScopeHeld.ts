import { useAuth } from '../context/AuthContext';
import type { ScopeGroupId } from '../store/scopePickerStore';

/**
 * Whether the signed-in character has allowed a scope group. True when the
 * server hasn't said (an older server, or a character whose scopes aren't
 * recorded yet): the server treats unknown as "everything", and so do we, so
 * nobody sees a "Needs X" note for access they already have.
 */
export function useScopeHeld(group: ScopeGroupId): boolean {
  const { user } = useAuth();
  const held = user?.scopeGroups;
  return !held || held.includes(group);
}
