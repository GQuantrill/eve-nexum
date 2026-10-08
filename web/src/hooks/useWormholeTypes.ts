import { createStaticResource } from './createStaticResource';

export interface WormholeSpec {
  totalMass:     number;
  maxJumpMass:   number;
  massRegen:     number;
  lifetimeHours: number;
  dest:          string;
  src:           string[];
}

type WhMap = Record<string, WormholeSpec>;

// Static cluster data — load once per page, never refresh.
const { useResource, peek } = createStaticResource<WhMap>('/api/wormholes/types', {});
export const useWormholeTypes = useResource;

/** The loaded type table for non-React callers, or {} before it arrives.
 *  Used by the store to size a connection the moment its type is known. */
export const wormholeTypesSnapshot = (): WhMap => peek() ?? {};
