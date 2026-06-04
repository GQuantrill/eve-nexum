import { createPolledResource } from './createPolledResource';

export interface InsurgencySystem {
  systemId:         number;
  campaignId:       number;
  factionId:        number;
  factionName:      string;
  factionLogoUrl:   string;
  corruptionPct:    number;
  corruptionState:  number;
  suppressionPct:   number;
  suppressionState: number;
}

const { useResource } = createPolledResource<InsurgencySystem>('/api/insurgency', 60 * 60 * 1000);
export const useInsurgency = useResource;

export function findInsurgency(insurgencies: InsurgencySystem[], eveSystemId: number | null): InsurgencySystem | undefined {
  if (!eveSystemId) return undefined;
  return insurgencies.find((i) => i.systemId === eveSystemId);
}
