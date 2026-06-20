import { createStaticResource } from './createStaticResource';

export interface ShatteredSystem {
  id:         number;
  name:       string;
  regionName: string;
}

// The shattered list is static cluster data — load once per page, never refresh.
const { useResource } = createStaticResource<ShatteredSystem[]>('/api/systems/shattered', []);
export const useShatteredSystems = useResource;
