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
const { useResource } = createStaticResource<WhMap>('/api/wormholes/types', {});
export const useWormholeTypes = useResource;
