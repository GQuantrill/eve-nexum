import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: vi.fn().mockResolvedValue({}), apiUrl: (p: string) => p }));
vi.mock('../store/pendingQueue', async (importActual) => {
  const actual = await importActual<typeof import('../store/pendingQueue')>();
  return { ...actual, enqueue: vi.fn(), flushQueue: vi.fn() };
});
vi.mock('../hooks/useWormholeTypes', () => ({
  useWormholeTypes: () => ({}),
  wormholeTypesSnapshot: () => ({ C008: { maxJumpMass: 5_000_000 } }),
}));

import { useMapStore } from '../store/mapStore';
import { reevaluateConnectionsForSystem } from './whAutoDetect';

const sys = (id: string, name: string, systemClass: string) =>
  ({ id, name, systemClass, eveSystemId: 1, position: { x: 0, y: 0 } } as never);

const sig = (id: string, whType: string, whLeadsTo: string) =>
  ({ id, sigId: id, sigType: 'wormhole', name: '', notes: '', whType, whLeadsTo,
     ghostType: '', massStatus: '', timeStatus: '' } as never);

/** The reported shape: a C1 with two holes that both lead to the same C5. */
function seedTwoHolesToOneSystem() {
  useMapStore.setState((s) => ({
    activeMapId: 'm1',
    map: {
      ...s.map, id: 'm1',
      systems: [sys('home', 'J111111', 'C1'), sys('far', 'J222222', 'C5')],
      connections: [{
        id: 'c1', sourceId: 'home', targetId: 'far', sourceHandle: null, targetHandle: null,
        type: null, connectionType: 'standard', massStatus: null, timeStatus: null,
        size: 'large', massUsed: 0, eolAt: null, sourceSignatureId: null,
        targetSignatureId: null, broken: false, flagIcon: null, flagNote: null,
        flagBlink: false, flagColor: null, createdAt: new Date().toISOString(),
      }] as never,
    },
  }));
}
const connType = () => useMapStore.getState().map.connections[0].type;

describe('two holes leading to the same system', () => {
  // Both back the link, so the tie-break alone cannot tell them apart.
  const sigs = [sig('K-1', 'K162', 'J222222'), sig('C-1', 'C008', 'J222222')];

  beforeEach(() => { seedTwoHolesToOneSystem(); });

  it('uses the hole the pilot said they jumped, even when it is the K162', () => {
    // The bug: the pilot picks the K162 in the "which one did you jump?"
    // prompt and the map labels the link C008 anyway.
    reevaluateConnectionsForSystem('home', sigs, undefined, false, undefined, 'K-1');
    expect(connType()).toBe('K162');
  });

  it('uses the picked hole when that is the typed one', () => {
    reevaluateConnectionsForSystem('home', sigs, undefined, false, undefined, 'C-1');
    expect(connType()).toBe('C008');
  });

  it('still prefers the typed hole when nobody has picked', () => {
    // Unchanged for every other caller: with no answer to go on, a named type
    // tells you more than a K162.
    reevaluateConnectionsForSystem('home', sigs, undefined, false);
    expect(connType()).toBe('C008');
  });

  it('ignores a pick that does not back this link', () => {
    reevaluateConnectionsForSystem('home', sigs, undefined, false, undefined, 'not-here');
    expect(connType()).toBe('C008');
  });
});
