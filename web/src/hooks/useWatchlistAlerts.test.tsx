import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const s = vi.hoisted(() => ({
  map: { systems: [] as { id: string; name: string }[], connections: [] as unknown[] },
  activeMapId: 'm1' as string | null,
  sigTypesBySystem: {} as Record<string, string[]>,
  leadsToClassesBySystem: {} as Record<string, string[]>,
  sigIndexMapId: null as string | null,
  desktop: [] as string[],
}));

vi.mock('../store/mapStore', () => ({ useMapStore: (sel: (st: typeof s) => unknown) => sel(s) }));
// Desktop on (it's off by default), sound off.
vi.mock('./useUserSetting', () => ({ useUserSetting: (k: string) => [/desktop/i.test(k), () => {}] }));
vi.mock('./useWatchlist', () => ({ useWatchlist: () => [WATCH] }));
vi.mock('../context/ShareModeContext', () => ({ useShareMode: () => ({ isShareMode: false }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../utils/toastStore', () => ({ toast: { info: () => {} } }));
// Watching for one wormhole type: a system matches once that sig is scanned.
vi.mock('../utils/watchMatch', () => ({
  matchSystem: (_e: unknown, _sys: unknown, sigTypes?: string[]) => (sigTypes?.includes('H296') ? { marker: 'watch' } : null),
  matchConnection: () => null,
}));
vi.mock('../utils/notificationPrefs', async (orig) => ({
  ...(await orig<typeof import('../utils/notificationPrefs')>()),
  alertGain: () => 0,
  fireDesktopNotification: (_t: string, body: string) => s.desktop.push(body),
}));

const WATCH = [{ id: 'w1' }];

import { useWatchlistAlerts } from './useWatchlistAlerts';

describe('useWatchlistAlerts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    s.desktop = [];
    s.activeMapId = 'm1';
    s.map = { systems: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }], connections: [] };
    s.sigTypesBySystem = {};
    s.sigIndexMapId = null;
  });
  afterEach(() => { vi.useRealTimers(); });

  const alerts = () => s.desktop;

  it('stays quiet when the signature index arrives late with matches already scanned', () => {
    const { rerender } = renderHook(() => useWatchlistAlerts());
    vi.advanceTimersByTime(10_000);           // far beyond the old 1.5s window
    s.sigTypesBySystem = { A: ['H296'] };
    s.sigIndexMapId = 'm1';
    rerender();
    vi.advanceTimersByTime(2000);
    rerender();
    expect(alerts()).toEqual([]);
  });

  it('does not re-alert a match that drops out and comes back', () => {
    s.sigIndexMapId = 'm1';
    const { rerender } = renderHook(() => useWatchlistAlerts());
    vi.advanceTimersByTime(2000);
    rerender();
    s.sigTypesBySystem = { B: ['H296'] };     // a genuine new scan
    rerender();
    s.sigTypesBySystem = {};                  // a refetch blip
    rerender();
    s.sigTypesBySystem = { B: ['H296'] };
    rerender();
    expect(alerts()).toHaveLength(1);
  });
});
