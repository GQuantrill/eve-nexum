import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { CLASS_LABELS } from '../data/wormholes';
import type { SystemClass } from '../types';

export interface SystemSearchResult {
  id: number;
  name: string;
  security: number;
  systemClass: string;
  regionName?: string | null;
}

const K_SPACE_CLASSES = new Set(['HS', 'LS', 'NS']);

/** Secondary label shown next to a system in the search dropdowns. Wormhole /
 *  J-space systems show their class (C3, C5, Thera…) — the J-space region code
 *  ("C-R00012") means nothing to a hunter — while k-space systems keep their
 *  region name. */
export function systemResultLabel(r: SystemSearchResult): string {
  const cls = r.systemClass;
  if (K_SPACE_CLASSES.has(cls)) return r.regionName ?? CLASS_LABELS[cls as SystemClass] ?? cls;
  return CLASS_LABELS[cls as SystemClass] ?? cls;
}

export interface SystemDetail extends SystemSearchResult {
  effect: string;
  statics: string[];
  regionName?: string;
  npcType?: string;
}

export async function fetchSystemDetail(id: number): Promise<SystemDetail> {
  return api<SystemDetail>(`/api/systems/${id}`);
}

export function useEsiSearch(query: string, debounceMs = 300) {
  const [results, setResults] = useState<SystemSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setLoading(true);
      setError(null);

      try {
        const data = await api<SystemSearchResult[]>(
          `/api/systems/search?q=${encodeURIComponent(query)}`,
          { signal: abortRef.current.signal },
        );
        setResults(data);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError('Search failed');
      } finally {
        setLoading(false);
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  return { results, loading, error };
}
