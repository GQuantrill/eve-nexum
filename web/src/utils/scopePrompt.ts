import i18n from '../i18n';
import { ApiError } from '../api/client';
import { toast } from './toastStore';
import { useScopePickerStore, type ScopeGroupId } from '../store/scopePickerStore';

// The server's answer when a character hasn't allowed the ESI scopes a feature
// needs: 403 { error: 'scope_missing', group }.
export function isScopeMissing(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 403 && err.code === 'scope_missing';
}

/**
 * The "Needs X. Enable" prompt: says which access a feature needs and which
 * character hasn't allowed it, with an Enable button that opens the picker for
 * that character with the group already ticked. Features stay visible and say
 * what they need; nothing is hidden.
 *
 * charId is the account character (users.id); omitted = the signed-in one.
 */
export function promptForScope(group: ScopeGroupId, who: { charId?: number; characterName?: string } = {}) {
  const groupName = i18n.t(`scopes.groups.${group}.title`);
  const msg = who.characterName
    ? i18n.t('scopes.needsChar', { name: who.characterName, group: groupName })
    : i18n.t('scopes.needsSelf', { group: groupName });
  toast.show(msg, {
    kind: 'error',
    ttlMs: 12_000,
    dedupeKey: `scope:${group}:${who.charId ?? 'me'}`,
    actions: [{
      label: i18n.t('scopes.enable'),
      primary: true,
      onClick: () => useScopePickerStore.getState().open({ kind: 'change', charId: who.charId, require: group }),
    }],
  });
}
