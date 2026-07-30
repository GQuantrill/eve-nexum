import { useEffect } from 'react';
import { create } from 'zustand';
import type { Icon } from '@phosphor-icons/react';

// Resolve / list Phosphor icons by base name (e.g. 'Skull' → SkullIcon), for the
// custom-label / connection-flag icon picker and node rendering.
//
// Phosphor ships ~9000 icon variants. Importing the WHOLE set here (via
// `import * as Phosphor`) previously pulled the entire library into the main
// bundle AND defeated tree-shaking app-wide — the single biggest contributor to
// an ~8 MB entry chunk. It is now LAZY-loaded on first need: the ~40 icons used
// directly elsewhere use named imports and tree-shake normally; the full set is
// dynamic-imported only when a map actually shows a user-chosen icon or a picker
// dialog opens (see DynamicIcon + usePhosphorIcons). `import type { Icon }` is
// erased at build time, so it doesn't pull the runtime library.

const SUFFIX = 'Icon';
type PhosphorModule = Record<string, unknown>;

// Phosphor icons are forwardRef components — OBJECTS, not functions — so a
// `typeof === 'function'` check rejects every one. Accept any non-null export.
const isComponent = (v: unknown): boolean =>
  v != null && (typeof v === 'object' || typeof v === 'function');

// The loaded module + its base names, kept outside React (non-serialisable, and
// resolution during render must be synchronous once loaded).
let mod: PhosphorModule | null = null;
let loading: Promise<void> | null = null;

interface PhosphorState {
  loaded: boolean;
  names:  string[];          // every base icon name, sorted — populated once loaded
  ensureLoaded: () => void;  // idempotent; kicks off the one lazy import
}

export const usePhosphorStore = create<PhosphorState>((set) => ({
  loaded: false,
  names: [],
  ensureLoaded: () => {
    if (mod || loading) return;
    loading = import('@phosphor-icons/react')
      .then((m) => {
        mod = m as unknown as PhosphorModule;
        const names = Object.keys(mod)
          .filter((k) => k.endsWith(SUFFIX) && k !== SUFFIX && isComponent(mod![k]))
          .map((k) => k.slice(0, -SUFFIX.length))
          .filter((n) => n.length > 0)
          .sort();
        set({ loaded: true, names });
      })
      .catch(() => { loading = null; });
  },
}));

// Synchronous resolve from the loaded module. Returns null until the lazy import
// finishes — callers subscribe via usePhosphorIcons so they re-render then.
export function iconComponent(name: string): Icon | null {
  if (!mod) return null;
  const c = mod[`${name}${SUFFIX}`];
  return isComponent(c) ? (c as Icon) : null;
}

// Ensures the set is loading and re-renders the caller when it's ready. `names`
// is empty until loaded; `resolve` returns null until then.
export function usePhosphorIcons(): { ready: boolean; names: string[]; resolve: (name: string) => Icon | null } {
  const ready = usePhosphorStore((s) => s.loaded);
  const names = usePhosphorStore((s) => s.names);
  const ensureLoaded = usePhosphorStore((s) => s.ensureLoaded);
  useEffect(() => { ensureLoaded(); }, [ensureLoaded]);
  return { ready, names, resolve: iconComponent };
}
