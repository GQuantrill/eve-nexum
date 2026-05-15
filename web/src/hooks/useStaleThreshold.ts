import { useEffect, useState } from 'react';

const KEY = 'nexum.staleThresholdH';
// 30 days × 24 hours — chains move fast in some wormholes, slow in others,
// so a month covers most "is this still relevant?" cases without forcing
// users to bump it on first use.
const DEFAULT_H = 24 * 30;

function read(): number {
  const raw = localStorage.getItem(KEY);
  if (!raw) return DEFAULT_H;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_H;
  return n;
}

// Cross-component subscription. localStorage's `storage` event only fires
// in *other* tabs, so updates inside the same tab need a manual fan-out —
// otherwise the sidebar updates but every SystemNode keeps its stale copy.
const listeners = new Set<(h: number) => void>();
let current = read();

function broadcast(v: number) {
  current = v;
  for (const l of listeners) l(v);
}

export function useStaleThreshold(): [number, (h: number) => void] {
  const [v, setV] = useState<number>(current);

  useEffect(() => {
    const listener = (n: number) => setV(n);
    listeners.add(listener);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) broadcast(read());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return [
    v,
    (h: number) => {
      const next = Math.max(1, Math.floor(h));
      localStorage.setItem(KEY, String(next));
      broadcast(next);
    },
  ];
}
