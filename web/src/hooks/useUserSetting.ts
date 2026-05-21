import { useSyncExternalStore } from 'react';
import { api } from '../api/client';

/**
 * Cross-device user-settings store. Each setting key is a string and
 * the value is JSON-serialisable. Backed by `users.ui_settings` (JSONB)
 * on the server and mirrored to localStorage for instant first-paint
 * on the next reload.
 *
 * Flow:
 *   1. App boot fetches /auth/me, calls `seedUserSettings(user.uiSettings)`.
 *   2. Components call `useUserSetting(key, default)` — returns [value, set].
 *   3. `set(v)` updates the in-memory cache, mirrors to localStorage,
 *      and debounces a PATCH to /auth/settings (500 ms window so a
 *      burst of toggles becomes one request).
 *   4. On first hydration, any localStorage values *missing* from the
 *      server side are uploaded — preserves settings made before the
 *      DB migration shipped.
 */

let cache: Record<string, unknown> = {};
let hydrated = false;

// Subscribers per key. Using a Map<key, Set<listener>> so we can notify
// every component watching a given key independently, without firing a
// global re-render when an unrelated key changes.
const subscribers = new Map<string, Set<() => void>>();
function emit(key: string): void {
  subscribers.get(key)?.forEach((fn) => fn());
}

// Pending PATCH state — coalesce a burst of writes into a single
// network call after a quiet period.
let pendingPatch: Record<string, unknown> = {};
let patchTimer: ReturnType<typeof setTimeout> | null = null;
function flush(): void {
  patchTimer = null;
  if (Object.keys(pendingPatch).length === 0) return;
  const body = JSON.stringify({ entries: pendingPatch });
  pendingPatch = {};
  api('/auth/settings', { method: 'PATCH', body }).catch((err) => {
    console.error('useUserSetting flush failed', err);
  });
}
function schedule(): void {
  if (patchTimer) clearTimeout(patchTimer);
  patchTimer = setTimeout(flush, 500);
}

export function seedUserSettings(initial: Record<string, unknown>): void {
  cache = { ...initial };
  hydrated = true;

  // Migration: any localStorage value that isn't on the server yet gets
  // uploaded. After this one-shot run the cross-device sync kicks in.
  try {
    const migrate: Record<string, unknown> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('nexum.')) continue;
      if (cache[k] !== undefined) continue;
      const raw = localStorage.getItem(k);
      if (raw === null) continue;
      try {
        // Some keys are stored as raw strings ("true", "false", "left"),
        // others as JSON. Try JSON.parse first; fall back to raw.
        const parsed = JSON.parse(raw);
        migrate[k] = parsed;
        cache[k] = parsed;
      } catch {
        migrate[k] = raw;
        cache[k] = raw;
      }
    }
    if (Object.keys(migrate).length > 0) {
      pendingPatch = { ...pendingPatch, ...migrate };
      schedule();
    }
  } catch { /* localStorage unavailable */ }

  // Wake every subscribed component to read its now-canonical value.
  for (const key of subscribers.keys()) emit(key);
}

function readSetting<T>(key: string, defaultValue: T): T {
  if (cache[key] !== undefined) return cache[key] as T;
  // Pre-hydration fall-through to localStorage so first-paint isn't
  // a flash of defaults. Cache the parsed value so `getSnapshot`
  // returns the same reference on every call — useSyncExternalStore
  // requires this or it throws "snapshot should be cached".
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      // Cache the default too, so consumers that pass a stable default
      // (e.g. a module-level constant array) get a stable reference back.
      cache[key] = defaultValue;
      return defaultValue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    cache[key] = parsed;
    return parsed as T;
  } catch {
    return defaultValue;
  }
}

function writeSetting<T>(key: string, value: T): void {
  cache[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
  pendingPatch[key] = value;
  schedule();
  emit(key);
}

type Setter<T> = (next: T | ((prev: T) => T)) => void;

export function useUserSetting<T>(key: string, defaultValue: T): [T, Setter<T>] {
  // useSyncExternalStore gives us a stable subscribe + getSnapshot that
  // React 19 prefers — and avoids the "snapshot should be cached"
  // warning we hit with naive Zustand-style selectors.
  const subscribe = (cb: () => void) => {
    let set = subscribers.get(key);
    if (!set) { set = new Set(); subscribers.set(key, set); }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) subscribers.delete(key);
    };
  };
  const getSnapshot = () => readSetting<T>(key, defaultValue);

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setValue: Setter<T> = (next) => {
    const resolved = typeof next === 'function'
      ? (next as (prev: T) => T)(readSetting<T>(key, defaultValue))
      : next;
    writeSetting(key, resolved);
  };
  return [value, setValue];
}

// Read once (no subscription) — useful for code paths that just need
// the current value, like a Zustand store init.
export function readUserSetting<T>(key: string, defaultValue: T): T {
  return readSetting(key, defaultValue);
}

// Write without using the hook — for code outside React (the Zustand
// store, for example).
export function writeUserSetting<T>(key: string, value: T): void {
  writeSetting(key, value);
}

// Internal: signals whether /auth/me has populated the cache.
export function isHydrated(): boolean { return hydrated; }

// Helper for tests / forced re-init.
export function _resetUserSettingsForTests(): void {
  cache = {};
  hydrated = false;
  pendingPatch = {};
  if (patchTimer) { clearTimeout(patchTimer); patchTimer = null; }
  subscribers.clear();
}

// Flush any pending patch immediately. Called on `beforeunload` so a
// last-second toggle doesn't get lost.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (patchTimer) flush();
  });
}
