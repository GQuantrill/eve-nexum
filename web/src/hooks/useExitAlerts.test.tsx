import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type Sys = { id: string; name: string; systemClass: string; security: number | null };
type Conn = { id: string; sourceId: string; targetId: string; connectionType: string; broken: boolean };

const s = vi.hoisted(() => ({
  map: { systems: [] as Sys[], connections: [] as Conn[] },
  activeMapId: 'm1' as string | null,
  settings: {} as Record<string, unknown>,
  toasts: [] as string[],
  desktop: [] as string[],
}));

vi.mock('../store/mapStore', () => ({
  useMapStore: (sel: (st: typeof s) => unknown) => sel(s),
}));
vi.mock('./useUserSetting', () => ({
  useUserSetting: (key: string, def: unknown) => [key in s.settings ? s.settings[key] : def, () => {}],
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => `${k}:${o?.name ?? o?.count ?? ''}` }),
}));
vi.mock('../utils/toastStore', () => ({ toast: { info: (m: string) => s.toasts.push(m) } }));
vi.mock('../utils/notificationPrefs', async (orig) => ({
  ...(await orig<typeof import('../utils/notificationPrefs')>()),
  alertGain: () => 0,
  fireDesktopNotification: (_t: string, body: string) => s.desktop.push(body),
}));

import { useExitAlerts } from './useExitAlerts';
import { NOTIFY, EXITS_MIN_SECURITY_KEY, EXITS_MIN_SECURITY_OFF } from '../utils/notificationPrefs';

const sys = (id: string, cls: string, security: number | null = cls === 'HS' ? 0.9 : -0.3): Sys =>
  ({ id, name: id, systemClass: cls, security });
const wh   = (id: string, a: string, b: string): Conn => ({ id, sourceId: a, targetId: b, connectionType: 'standard', broken: false });
const gate = (id: string, a: string, b: string): Conn => ({ id, sourceId: a, targetId: b, connectionType: 'gate', broken: false });

function settle(rerender: () => void) {
  vi.advanceTimersByTime(2000);
  rerender();
}

describe('useExitAlerts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    s.toasts = []; s.desktop = [];
    s.activeMapId = 'm1';
    s.settings = { [NOTIFY.exitsDesktop]: true, [EXITS_MIN_SECURITY_KEY]: -1 };
    // A chain with a nullsec exit, plus a pocket of k-space joined by gates.
    s.map = {
      systems: [sys('J1', 'C2'), sys('N1', 'NS'), sys('N2', 'NS'), sys('N3', 'NS'), sys('H1', 'HS')],
      connections: [wh('c1', 'J1', 'N1'), gate('g1', 'N1', 'N2'), gate('g2', 'N2', 'N3')],
    };
  });
  afterEach(() => { vi.useRealTimers(); });

  it('says nothing about what is already mapped when switched on', () => {
    s.settings[EXITS_MIN_SECURITY_KEY] = EXITS_MIN_SECURITY_OFF;
    const { rerender } = renderHook(() => useExitAlerts());
    s.settings[EXITS_MIN_SECURITY_KEY] = -1;   // switched on with the chain already there
    rerender();
    settle(rerender);
    expect(s.toasts).toEqual([]);
    expect(s.desktop).toEqual([]);
  });

  it('alerts for a new wormhole into k-space, once', () => {
    const { rerender } = renderHook(() => useExitAlerts());
    settle(rerender);
    s.map = { ...s.map, connections: [...s.map.connections, wh('c2', 'J1', 'H1')] };
    rerender();
    rerender();
    expect(s.desktop).toEqual(['exits.appeared:H1']);
  });

  it('never treats stargate neighbours as exits', () => {
    const { rerender } = renderHook(() => useExitAlerts());
    settle(rerender);
    s.map = {
      systems: [...s.map.systems, sys('N4', 'NS')],
      connections: [...s.map.connections, gate('g3', 'N3', 'N4')],
    };
    rerender();
    expect(s.desktop).toEqual([]);
  });

  it('summarises a burst of new exits in one alert', () => {
    const { rerender } = renderHook(() => useExitAlerts());
    settle(rerender);
    const extra = ['A', 'B', 'C', 'D', 'E'].map((x) => sys(`N${x}`, 'NS'));
    s.map = {
      systems: [...s.map.systems, ...extra],
      connections: [...s.map.connections, ...extra.map((e, i) => wh(`w${i}`, 'J1', e.id))],
    };
    rerender();
    expect(s.desktop).toEqual(['exits.appearedMany:5']);
  });
});
