import { createContext, useContext } from 'react';
import type { PilotSight } from '../utils/pilotWatch';

// Watched pilots seen in each system (by EVE id), newest first. Built once in
// MapCanvas from the Intel panel's watch list, so each node only looks up its
// own system. Empty when the "mark on map" toggle is off.
export const PilotSightContext = createContext<Map<number, PilotSight[]>>(new Map());

export const usePilotSights = (eveSystemId: number | null): PilotSight[] | undefined => {
  const all = useContext(PilotSightContext);
  return eveSystemId != null ? all.get(eveSystemId) : undefined;
};
