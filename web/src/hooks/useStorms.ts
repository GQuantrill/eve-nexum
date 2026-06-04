import { createPolledResource } from './createPolledResource';

export type StormType = 'electric' | 'gamma' | 'exotic' | 'plasma' | 'unknown';

export interface StormSystem {
  eveSystemId:    number | null;
  systemName:     string;
  regionName:     string;
  stormName:      string;
  stormType:      StormType;
  lastReport:     string;
  hoursInSystem:  number | null;
  reportedBy:     string;
}

const { useResource } = createPolledResource<StormSystem>('/api/storms', 30 * 60 * 1000);
export const useStorms = useResource;

export function findStorm(storms: StormSystem[], eveSystemId: number | null): StormSystem | undefined {
  if (!eveSystemId) return undefined;
  return storms.find((s) => s.eveSystemId === eveSystemId);
}
