import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import {
  SCOPE, SCOPE_GROUPS, SCOPE_GROUP_IDS, isScopeGroupId, type EsiScope, type ScopeGroupId,
} from '../utils/esiScopes.js';

const log = createLogger('ssoScopes');

// Which scopes an EVE login asks for.
//
// SSO_SCOPES_MODE=all (the default): every login asks for every scope, as it
// always has, and there is no picker. SSO_SCOPES_MODE=choice: the login shows
// the groups below and the pilot unticks what they don't want.
//
// Every scope here must be enabled on the deployment's EVE application, or SSO
// refuses every login with invalid_scope. Asking for FEWER than the
// application has is always fine, which is why a pilot unticking a group, or a
// scope being dropped from the list, can never break anyone's login.

// Asked for on every login but not shown in the picker: the admin invite mail,
// until it gets its own admin-only login like the corp wallet's.
const UNGROUPED: readonly EsiScope[] = [SCOPE.openWindow];

// The groups this deployment has at all. Clones only exists where the operator
// has enabled its scope on their EVE application (ESI_CLONES_SCOPE).
export function availableGroups(): ScopeGroupId[] {
  return SCOPE_GROUP_IDS.filter((g) => g !== 'clones' || config.cloneScope);
}

let warned = false;

// The groups a pilot may untick. None in 'all' mode; location never.
export function optionalGroups(): Set<ScopeGroupId> {
  if (config.ssoScopesMode !== 'choice') return new Set();
  const listed = config.ssoOptionalGroups;
  if (listed && !warned) {
    warned = true;
    const unknown = listed.filter((g) => !isScopeGroupId(g));
    if (unknown.length) log.warn(`SSO_OPTIONAL_GROUPS: ignoring unknown group(s): ${unknown.join(', ')}`);
  }
  return new Set(availableGroups().filter((g) => g !== 'location' && (listed == null || listed.includes(g))));
}

// What the login screen needs to draw the picker.
export function scopeOptions(): { mode: 'all' | 'choice'; groups: { id: ScopeGroupId; optional: boolean }[] } {
  const optional = optionalGroups();
  return {
    mode:   config.ssoScopesMode,
    groups: availableGroups().map((id) => ({ id, optional: optional.has(id) })),
  };
}

// Parse the ?groups= a login was started with: the optional groups the pilot
// ticked. Absent means "everything", the same as all ticked.
export function parseChosenGroups(raw: unknown): ScopeGroupId[] | null {
  if (typeof raw !== 'string') return null;
  return raw.split(',').map((g) => g.trim()).filter(isScopeGroupId);
}

// The scopes to ask EVE for: every required group, the optional groups the
// pilot chose (all of them when they didn't choose), and the ungrouped ones.
export function requestedScopes(chosen: readonly ScopeGroupId[] | null): string[] {
  const optional = optionalGroups();
  const groups = availableGroups().filter((g) => !optional.has(g) || chosen == null || chosen.includes(g));
  return [...new Set([...groups.flatMap((g) => SCOPE_GROUPS[g]), ...UNGROUPED])];
}
