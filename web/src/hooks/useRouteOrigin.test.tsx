import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Shared state the mocks read; each test sets what it needs.
const s = {
  settings: {} as Record<string, unknown>,
  location: { online: false, system: null as null | { eveSystemId: number; name: string; systemClass: string } },
  lastKnown: null as null | { id: number; name: string; systemClass: string },
  store: {
    routeFromSystem: null as null | { eveSystemId: number; systemName: string; systemClass: string | null },
    routeOrigin: null as null | { charId: number; characterName: string; eveSystemId: number; systemName: string; systemClass: string | null },
    activeMapId: 'm1' as string | null,
    map: { systems: [] as Array<{ eveSystemId: number | null }> },
  },
};

vi.mock('../store/mapStore', () => ({
  useMapStore: (sel: (st: typeof s.store) => unknown) => sel(s.store),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (f: unknown) => f }));
vi.mock('./useUserSetting', () => ({
  useUserSetting: (key: string, def: unknown) => [key in s.settings ? s.settings[key] : def, () => {}],
}));
vi.mock('./useCharacterLocation', () => ({ useCharacterLocation: () => s.location }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { lastKnownSystem: s.lastKnown } }) }));

const { useRouteOrigin } = await import('./useRouteOrigin');

const J = { eveSystemId: 31000001, name: 'J100001', systemClass: 'C3' };
const SOSA = { eveSystemId: 30003069, name: 'Sosa', systemClass: 'LS' };

beforeEach(() => {
  s.settings = {};
  s.location = { online: false, system: null };
  s.lastKnown = null;
  s.store.routeFromSystem = null;
  s.store.routeOrigin = null;
  s.store.map.systems = [];
});

const origin = (scope?: 'active' | 'all') => renderHook(() => useRouteOrigin(scope)).result.current;

describe('useRouteOrigin', () => {
  it('in a wormhole with the chain option off, says so', () => {
    s.location = { online: true, system: J };
    s.lastKnown = { id: J.eveSystemId, name: J.name, systemClass: J.systemClass };
    expect(origin()).toMatchObject({ systemId: null, blocked: 'wormholeOptionOff' });
  });

  it('a hole on no open map: refused for the open map, accepted across all maps', () => {
    s.settings['nexum.route.includeWormholes'] = true;
    s.location = { online: true, system: J };
    expect(origin('active')).toMatchObject({ systemId: null, blocked: 'notOnMap' });
    expect(origin('all')).toMatchObject({ systemId: J.eveSystemId, inWormhole: true, blocked: null });
    s.store.map.systems = [{ eveSystemId: J.eveSystemId }];
    expect(origin('active')).toMatchObject({ systemId: J.eveSystemId, inWormhole: true });
  });

  it('a system picked with Route from here wins over the pilot', () => {
    s.location = { online: true, system: { eveSystemId: 30000142, name: 'Jita', systemClass: 'HS' } };
    s.store.routeFromSystem = { eveSystemId: SOSA.eveSystemId, systemName: 'Sosa', systemClass: 'LS' };
    expect(origin()).toMatchObject({ systemId: SOSA.eveSystemId, pinnedSystem: true, name: 'Sosa', skipped: null });
  });

  it('a picked character in a hole falls back to the pilot, naming who was skipped', () => {
    s.location = { online: true, system: { eveSystemId: 30000142, name: 'Jita', systemClass: 'HS' } };
    s.store.routeOrigin = { charId: 2, characterName: 'Scout', eveSystemId: J.eveSystemId, systemName: J.name, systemClass: 'C3' };
    expect(origin()).toMatchObject({ systemId: 30000142, characterName: null, skipped: 'Scout' });
  });

  it('online in a hole still falls back to a k-space last known system', () => {
    s.location = { online: true, system: J };
    s.lastKnown = { id: SOSA.eveSystemId, name: 'Sosa', systemClass: 'LS' };
    expect(origin()).toMatchObject({ systemId: SOSA.eveSystemId, fromLastKnown: true });
  });
});
