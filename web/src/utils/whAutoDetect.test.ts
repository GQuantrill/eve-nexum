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

describe('deleting a sig severs the hole it backed', () => {
  // The eve-scout copy's shape: the far system holds a K162 leading to Thera,
  // Thera holds the Q063 leading back, and the link is labelled Q063.
  function seedTheraLink(overrides: Record<string, unknown> = {}) {
    useMapStore.setState((s) => ({
      activeMapId: 'm1',
      map: {
        ...s.map, id: 'm1',
        systems: [
          sys('far', 'Jita', 'HS'), sys('thera', 'Thera', 'Thera'), sys('ams', 'Amarr', 'HS'),
        ],
        connections: [{
          id: 'c1', sourceId: 'far', targetId: 'thera', sourceHandle: null, targetHandle: null,
          type: 'Q063', connectionType: 'standard', massStatus: null, timeStatus: null,
          size: 'large', massUsed: 0, eolAt: null, sourceSignatureId: null,
          targetSignatureId: null, broken: false, flagIcon: null, flagNote: null,
          flagBlink: false, flagColor: null, createdAt: new Date().toISOString(),
          ...overrides,
        }] as never,
      },
    }));
  }
  const broken = () => useMapStore.getState().map.connections[0].broken;

  it('breaks the link when the K162 end is deleted', () => {
    // The bug: the K162 never equals the Q063 label, so this did nothing.
    seedTheraLink();
    reevaluateConnectionsForSystem('far', [], sig('K-1', 'K162', 'Thera'), true);
    expect(broken()).toBe(true);
  });

  it('breaks the link when the typed end is deleted', () => {
    seedTheraLink();
    reevaluateConnectionsForSystem('thera', [], sig('Q-1', 'Q063', 'Jita'), true);
    expect(broken()).toBe(true);
  });

  it('does not let a hole to the same CLASS stand in for the deleted one', () => {
    // Thera full of "HS" exits: none of them is the hole to Jita.
    seedTheraLink();
    const left = [sig('B-1', 'B735', 'HS')];
    reevaluateConnectionsForSystem('thera', left, sig('Q-1', 'Q063', 'Jita'), true);
    expect(broken()).toBe(true);
  });

  it('keeps the link while another sig still leads to that exact system', () => {
    seedTheraLink();
    const left = [sig('Q-2', 'Q063', 'Jita')];
    reevaluateConnectionsForSystem('thera', left, sig('Q-1', 'Q063', 'Jita'), true);
    expect(broken()).toBe(false);
  });

  it('breaks the link a sig was linked to, even with no destination filled in', () => {
    seedTheraLink({ sourceSignatureId: 'K-1' });
    reevaluateConnectionsForSystem('far', [], sig('K-1', 'K162', ''), true);
    expect(broken()).toBe(true);
  });

  it('leaves a link to a different system alone', () => {
    seedTheraLink();
    reevaluateConnectionsForSystem('far', [], sig('K-9', 'K162', 'Amarr'), true);
    expect(broken()).toBe(false);
  });

  it('breaks the link of a hole pinned by name with no type filled in', () => {
    // Jumped before it was scanned: the pilot said which sig, so it leads to
    // Thera, but nobody typed its code. It vanishing must still cut the link.
    seedTheraLink();
    reevaluateConnectionsForSystem('far', [], sig('X-1', '', 'Thera'), true);
    expect(broken()).toBe(true);
  });

  it('keeps it while another sig, typed or not, is pinned to that system', () => {
    seedTheraLink();
    reevaluateConnectionsForSystem('far', [sig('X-2', '', 'Thera')], sig('X-1', '', 'Thera'), true);
    expect(broken()).toBe(false);
  });

  it('only clears, never breaks, on an edit', () => {
    seedTheraLink();
    reevaluateConnectionsForSystem('far', [], sig('K-1', 'K162', 'Thera'), false);
    expect(broken()).toBe(false);
  });
});

describe('linking the backing sig', () => {
  const HOUR = 3_600_000;
  function seed(connAgeH: number) {
    useMapStore.setState((s) => ({
      activeMapId: 'm1',
      map: {
        ...s.map, id: 'm1',
        systems: [sys('home', 'J111111', 'C2'), sys('far', 'J222222', 'C5')],
        connections: [{
          id: 'c1', sourceId: 'home', targetId: 'far', sourceHandle: null, targetHandle: null,
          type: 'H296', connectionType: 'standard', massStatus: null, timeStatus: null,
          size: 'large', massUsed: 0, eolAt: null, sourceSignatureId: null,
          targetSignatureId: null, broken: false, flagIcon: null, flagNote: null,
          flagBlink: false, flagColor: null, createdAt: new Date(Date.now() - connAgeH * HOUR).toISOString(),
        }] as never,
      },
    }));
  }
  const datedSig = (id: string, leadsTo: string, ageH: number) =>
    ({ ...(sig(id, 'H296', leadsTo) as object), createdAt: new Date(Date.now() - ageH * HOUR).toISOString() }) as never;
  const backing = () => useMapStore.getState().map.connections[0].sourceSignatureId;

  it('links a class-only sig scanned before the link was made', () => {
    seed(1);
    reevaluateConnectionsForSystem('home', [datedSig('s1', 'C5', 2)], undefined, false);
    expect(backing()).toBe('s1');
  });

  it("does not tie yesterday's link to today's new hole of the same class", () => {
    // Overwrite paste: the new H296 -> C5 is a different hole. Linking it kept
    // the old link alive, so it never scissored.
    seed(20);
    reevaluateConnectionsForSystem('home', [datedSig('s1', 'C5', 0)], undefined, false);
    expect(backing()).toBeNull();
  });

  it('links a sig pinned to the far system by name, whenever it was scanned', () => {
    seed(20);
    reevaluateConnectionsForSystem('home', [datedSig('s1', 'J222222', 0)], undefined, false);
    expect(backing()).toBe('s1');
  });
});

describe('a size noted on the sig before the jump', () => {
  it('goes to the connection when the sig is linked, and the sig copy is cleared', () => {
    seedTwoHolesToOneSystem();
    const consumed: string[] = [];
    const noted = { ...(sig('S-1', 'K162', 'J222222') as object), whSize: 'medium' } as never;
    reevaluateConnectionsForSystem('home', [noted], undefined, false, (id) => consumed.push(id));
    const c = useMapStore.getState().map.connections[0];
    expect(c.sourceSignatureId).toBe('S-1');
    expect(c.size).toBe('medium');
    expect(consumed).toEqual(['S-1']);
  });
});
