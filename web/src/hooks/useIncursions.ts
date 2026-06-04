import { createPolledResource } from './createPolledResource';

export interface IncursionSystem {
  systemId:       number;
  factionId:      number;
  factionName:    string;
  factionLogoUrl: string;
  state:          string;
  influence:      number;
  hasBoss:        boolean;
  isStaging:      boolean;
}

const { useResource } = createPolledResource<IncursionSystem>('/api/incursions', 60 * 60 * 1000);
export const useIncursions = useResource;

export function findIncursion(incursions: IncursionSystem[], eveSystemId: number | null): IncursionSystem | undefined {
  if (!eveSystemId) return undefined;
  return incursions.find((i) => i.systemId === eveSystemId);
}
