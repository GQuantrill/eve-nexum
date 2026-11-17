import { useEffect, useState } from 'react';
import { api, apiUrl } from './client';
import { SCOPE_GROUP_IDS, type ScopeGroupId, type ScopePickerTarget } from '../store/scopePickerStore';

export interface ScopeOptions {
  /** 'all': every login asks for everything, no picker. 'choice': the picker. */
  mode:   'all' | 'choice';
  groups: { id: ScopeGroupId; optional: boolean }[];
}

let cached: Promise<ScopeOptions> | null = null;

const FALLBACK: ScopeOptions = {
  mode:   'all',
  groups: SCOPE_GROUP_IDS.filter((id) => id !== 'clones').map((id) => ({ id, optional: false })),
};

// Fetched once per page load; public, so it works on the landing page too.
export function loadScopeOptions(): Promise<ScopeOptions> {
  cached ??= api<ScopeOptions>('/auth/scope-options').catch((err) => { cached = null; throw err; });
  return cached;
}

export function useScopeOptions(): ScopeOptions | null {
  const [opts, setOpts] = useState<ScopeOptions | null>(null);
  useEffect(() => {
    let live = true;
    // On failure, fall back to the server default ('all'): the picker still
    // explains each group and "Log in again" asks for whatever the server wants.
    loadScopeOptions().then(
      (o) => { if (live) setOpts(o); },
      () => { if (live) setOpts(FALLBACK); },
    );
    return () => { live = false; };
  }, []);
  return opts;
}

// Where the Continue button sends the pilot. Adding a character and changing
// one's access both go through the add-character flow, which re-authorises a
// character already on the account in place.
function ssoPath(target: ScopePickerTarget): string {
  if (target.kind === 'login') return '/auth/login';
  if (target.kind === 'add') return '/auth/add-character';
  return '/auth/add-character?intent=change';
}

export function loginUrl(target: ScopePickerTarget, options: ScopeOptions | null, ticked: ReadonlySet<string>): string {
  const path = ssoPath(target);
  if (!options || options.mode !== 'choice') return apiUrl(path);
  const groups = options.groups.filter((g) => g.optional && ticked.has(g.id)).map((g) => g.id).join(',');
  return apiUrl(`${path}${path.includes('?') ? '&' : '?'}groups=${encodeURIComponent(groups)}`);
}
