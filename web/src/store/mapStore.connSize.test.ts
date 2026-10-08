import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: vi.fn().mockResolvedValue({}), apiUrl: (p: string) => p }));
vi.mock('./pendingQueue', async (importActual) => {
  const actual = await importActual<typeof import('./pendingQueue')>();
  return { ...actual, enqueue: vi.fn(), flushQueue: vi.fn() };
});

// The SDE table the store consults. Real per-jump masses: C008 is a frigate
// hole, N110 a medium, B274 a large, and the C1 statics are medium.
vi.mock('../hooks/useWormholeTypes', () => ({
  useWormholeTypes: () => ({}),
  wormholeTypesSnapshot: () => ({
    C008: { maxJumpMass: 5_000_000 },
    N110: { maxJumpMass: 62_000_000 },
    B274: { maxJumpMass: 375_000_000 },
    A641: { maxJumpMass: 1_000_000_000 },
  }),
}));

import { useMapStore } from './mapStore';

const sys = (id: string, systemClass: string) => ({
  id, name: id, systemClass, eveSystemId: 1, position: { x: 0, y: 0 },
} as never);

function seed(aClass: string, bClass: string) {
  useMapStore.setState((s) => ({
    activeMapId: 'm1',
    map: {
      ...s.map, id: 'm1',
      systems: [sys('a', aClass), sys('b', bClass)],
      connections: [{
        id: 'c1', sourceId: 'a', targetId: 'b', sourceHandle: null, targetHandle: null,
        type: null, connectionType: 'standard', massStatus: null, timeStatus: null,
        size: 'large', massUsed: 0, eolAt: null, sourceSignatureId: null,
        targetSignatureId: null, broken: false, flagIcon: null, flagNote: null,
        flagBlink: false, flagColor: null, createdAt: new Date().toISOString(),
      }] as never,
    },
  }));
}
const sizeNow = () => useMapStore.getState().map.connections[0].size;

describe('connection size follows the wormhole type', () => {
  beforeEach(() => { seed('C5', 'C5'); });

  it('sizes a frigate hole the moment its type is set', () => {
    // The reported bug: this sat at the 'large' default until somebody opened
    // the connection panel, so a frigate hole read as L for a whole session.
    expect(sizeNow()).toBe('large');
    useMapStore.getState().updateConnection('c1', { type: 'C008' });
    expect(sizeNow()).toBe('small');
  });

  it('sizes the other classes too', () => {
    useMapStore.getState().updateConnection('c1', { type: 'N110' });
    expect(sizeNow()).toBe('medium');
    useMapStore.getState().updateConnection('c1', { type: 'A641' });
    expect(sizeNow()).toBe('xl');
  });

  it('caps at medium when an end is a C1, even for a large hole', () => {
    seed('C1', 'HS');
    useMapStore.getState().updateConnection('c1', { type: 'B274' });
    expect(sizeNow()).toBe('medium');
  });

  it('leaves the size alone for a type it does not know', () => {
    // K162 carries no size of its own; guessing would be worse than the default.
    useMapStore.getState().updateConnection('c1', { type: 'K162' });
    expect(sizeNow()).toBe('large');
  });

  it('lets an explicit size win over the inference', () => {
    // The Thera/Turnur copy knows the feed's own max-ship-size and passes it.
    useMapStore.getState().updateConnection('c1', { type: 'C008', size: 'xl' });
    expect(sizeNow()).toBe('xl');
  });

  it('does not touch size when the type is not what changed', () => {
    useMapStore.getState().updateConnection('c1', { massStatus: 'critical' });
    expect(sizeNow()).toBe('large');
  });
});

describe('the C1 cap through the store path', () => {
  it('caps a bare K162 out of a C1 at medium', () => {
    // The original #650 report. K162 carries no size of its own, so it sat at
    // the 'large' default and claimed a battleship fits. Previously only the
    // connection panel could correct this; now any path that sets the type does.
    seed('C1', 'HS');
    useMapStore.getState().updateConnection('c1', { type: 'K162' });
    expect(sizeNow()).toBe('medium');
  });

  it('leaves a K162 alone when neither end is a C1', () => {
    seed('C5', 'HS');
    useMapStore.getState().updateConnection('c1', { type: 'K162' });
    expect(sizeNow()).toBe('large');
  });
});

describe('a class that resolves after the type is known', () => {
  it('applies the C1 cap once the far system is classified', () => {
    // Jumping into an unresolved placeholder names the system first and
    // classifies it a moment later, so the hole already has its type by the
    // time we learn an end is a C1. Without this the cap would wait for
    // somebody to open the connection panel.
    seed('HS', 'unknown');
    useMapStore.getState().updateConnection('c1', { type: 'B274' });
    expect(sizeNow()).toBe('large');            // nothing yet says otherwise

    useMapStore.getState().updateSystem('b', { systemClass: 'C1' });
    expect(sizeNow()).toBe('medium');
  });

  it('leaves the size alone when the class resolves to something uncapped', () => {
    seed('HS', 'unknown');
    useMapStore.getState().updateConnection('c1', { type: 'B274' });
    useMapStore.getState().updateSystem('b', { systemClass: 'C5' });
    expect(sizeNow()).toBe('large');
  });
});
