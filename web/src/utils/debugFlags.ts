import { useSyncExternalStore } from 'react';

// Runtime-only debug flags, toggled from the `nexumDebug` console helpers and
// read reactively by React via useDebugFlag(). Never persisted — they reset on
// reload, so they can't leak into a normal session. Kept in a tiny external
// store (rather than a context) so plain modules like debug.ts can flip them
// without needing to be inside the React tree.
export interface DebugFlags {
  // Show the nearest detected threat in the toolbar regardless of the user's
  // proximity alert threshold — for eyeballing the proximity chip without an
  // in-zone incursion/insurgency.
  showThreats: boolean;
  // Force the "update available" toolbar badge on regardless of the real version
  // check — for eyeballing the indicator without cutting a newer release.
  forceUpdateBadge: boolean;
}

const flags: DebugFlags = {
  showThreats: false,
  forceUpdateBadge: false,
};

const listeners = new Set<() => void>();

export function getDebugFlag<K extends keyof DebugFlags>(key: K): DebugFlags[K] {
  return flags[key];
}

export function setDebugFlag<K extends keyof DebugFlags>(key: K, value: DebugFlags[K]): void {
  if (flags[key] === value) return;
  flags[key] = value;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactively read a debug flag; components re-render when it's toggled. */
export function useDebugFlag<K extends keyof DebugFlags>(key: K): DebugFlags[K] {
  return useSyncExternalStore(subscribe, () => flags[key]);
}
