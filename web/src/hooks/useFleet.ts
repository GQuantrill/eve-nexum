import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useShareMode } from '../context/ShareModeContext';

export interface FleetMember {
  characterId:     number;
  characterName:   string | null;
  solarSystemId:   number;
  solarSystemName: string | null;
}

export interface FleetState {
  inFleet: boolean;
  members: FleetMember[];
  /** Map from solarSystemId → members in that system. Built once per
   *  poll so SystemNode lookups are O(1). */
  bySystem: Map<number, FleetMember[]>;
}

interface RawResponse {
  inFleet: boolean;
  members: Array<{
    character_id:      number;
    character_name?:   string;
    solar_system_id:   number;
    solar_system_name?: string | null;
  }>;
}

const POLL_MS = 20_000;
const EMPTY: FleetState = { inFleet: false, members: [], bySystem: new Map() };

let moduleCache: { data: FleetState; fetchedAt: number } | null = null;
let inflight: Promise<FleetState> | null = null;
const subscribers = new Set<(d: FleetState) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function indexBySystem(members: FleetMember[]): Map<number, FleetMember[]> {
  const idx = new Map<number, FleetMember[]>();
  for (const m of members) {
    const list = idx.get(m.solarSystemId);
    if (list) list.push(m);
    else idx.set(m.solarSystemId, [m]);
  }
  return idx;
}

function notify(d: FleetState) {
  subscribers.forEach((fn) => fn(d));
}

function load() {
  if (inflight) return inflight;
  inflight = api<RawResponse>('/api/character/fleet')
    .then((r) => {
      const members: FleetMember[] = r.members.map((m) => ({
        characterId:     m.character_id,
        characterName:   m.character_name ?? null,
        solarSystemId:   m.solar_system_id,
        solarSystemName: m.solar_system_name ?? null,
      }));
      const data: FleetState = { inFleet: r.inFleet, members, bySystem: indexBySystem(members) };
      moduleCache = { data, fetchedAt: Date.now() };
      inflight = null;
      notify(data);
      return data;
    })
    .catch(() => {
      inflight = null;
      return moduleCache?.data ?? EMPTY;
    });
  return inflight;
}

/**
 * Subscribe to the user's current fleet roster. Shared module cache means
 * every component on the page consumes a single poll; switching from one
 * SystemNode to another doesn't multiply the ESI cost.
 */
export function useFleet(): FleetState {
  const { isShareMode } = useShareMode();
  const [data, setData] = useState<FleetState>(moduleCache?.data ?? EMPTY);

  useEffect(() => {
    // Share viewers don't have a session; the /api/character/fleet endpoint
    // would 401. Short-circuit to the empty state so the SystemNode dot
    // never renders for a guest.
    if (isShareMode) return;

    subscribers.add(setData);
    const now = Date.now();
    if (!moduleCache || now - moduleCache.fetchedAt >= POLL_MS) load();
    else setData(moduleCache.data);
    if (!pollTimer) pollTimer = setInterval(load, POLL_MS);
    return () => {
      subscribers.delete(setData);
      if (subscribers.size === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, [isShareMode]);

  return isShareMode ? EMPTY : data;
}
