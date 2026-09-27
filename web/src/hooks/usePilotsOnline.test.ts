import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: apiMock }));

// The store is module-level, so each case needs its own module instance — and a
// clean localStorage, or the cross-tab channel hands the next case the value the
// previous one published and the mount fetch is skipped.
//
// pilotActivity has to come from the SAME fresh registry as the store: reset the
// modules and then call the old module's setter and the store is reading a
// different copy of the flag, which silently leaves it at the fast cadence.
async function fresh() {
  vi.resetModules();
  const activity = await import('./pilotActivity');
  const mod = await import('./usePilotsOnline');
  return { usePilotsOnline: mod.usePilotsOnline, setPilotOnline: activity.setPilotOnline };
}

describe('usePilotsOnline cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    apiMock.mockReset();
    apiMock.mockResolvedValue([]);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('polls every 30s while the pilot is in game', async () => {
    const { usePilotsOnline, setPilotOnline } = await fresh();
    setPilotOnline(true);
    const { unmount } = renderHook(() => usePilotsOnline());
    // One act per tick: the in-flight de-dupe only clears once the previous
    // promise settles, and fake timers fire without flushing it.
    for (let i = 0; i < 3; i++) await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(apiMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    unmount();
  });

  it('eases off to 90s once they log out, rather than stopping', async () => {
    const { usePilotsOnline, setPilotOnline } = await fresh();
    setPilotOnline(false);
    const { unmount } = renderHook(() => usePilotsOnline());

    // 60s in: past two fast ticks, but not yet the idle one.
    for (let i = 0; i < 2; i++) await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(apiMock.mock.calls.length).toBe(1);            // just the mount fetch

    // This is who ELSE is around, so it has to keep moving while you're out —
    // the back-off is a third of the rate, not a halt.
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(apiMock.mock.calls.length).toBe(2);
    unmount();
  });

  it('speeds back up the moment they log in', async () => {
    const { usePilotsOnline, setPilotOnline } = await fresh();
    setPilotOnline(false);
    const { unmount } = renderHook(() => usePilotsOnline());
    await act(async () => { vi.advanceTimersByTime(90_000); });
    const idleCalls = apiMock.mock.calls.length;

    setPilotOnline(true);
    // A tick is already scheduled at the idle gap, so the first one after
    // logging in still waits it out; from then on it is the fast rate.
    await act(async () => { vi.advanceTimersByTime(90_000); });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(apiMock.mock.calls.length).toBeGreaterThanOrEqual(idleCalls + 3);
    unmount();
  });
});
