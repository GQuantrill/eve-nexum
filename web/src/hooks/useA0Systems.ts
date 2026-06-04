import { createStaticResource } from './createStaticResource';

export interface A0System {
  id:         number;
  name:       string;
  regionName: string;
}

// The A0 list is static cluster data — load once per page, never refresh.
const { useResource } = createStaticResource<A0System[]>('/api/systems/a0', []);
export const useA0Systems = useResource;
