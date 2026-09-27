import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createPolledStore } from './createPolledStore';
import { setPilotOnline, pilotIsOffline, _resetPilotActivityForTests } from './pilotActivity';

beforeEach(() => { vi.useFakeTimers(); _resetPilotActivityForTests(); });
afterEach(() => { vi.useRealTimers(); });

describe('pilotIsOffline', () => {
  it('is false until we actually know', () => {
    // Never back off on a guess: an unknown state must poll at full rate.
    expect(pilotIsOffline()).toBe(false);
    setPilotOnline(null);
    expect(pilotIsOffline()).toBe(false);
  });

  it('is true only on a definite logged-out answer', () => {
    setPilotOnline(true);
    expect(pilotIsOffline()).toBe(false);
    setPilotOnline(false);
    expect(pilotIsOffline()).toBe(true);
  });
});

describe('createPolledStore idle cadence', () => {
  // Build the store ONCE per case — constructing it inside renderHook would
  // make a fresh store (and a fresh timer) on every render.
  const build = (doFetch: () => Promise<number>) => createPolledStore<number>({
    fetch: doFetch, pollMs: 10_000, idlePollMs: 60_000, idle: pilotIsOffline, empty: 0,
  });

  it('polls at the fast rate while the pilot is in game', async () => {
    const doFetch = vi.fn().mockResolvedValue(1);
    setPilotOnline(true);
    const store = build(doFetch);
    const { unmount } = renderHook(() => store.use());
    // One act per tick: the in-flight de-dupe only clears once the previous
    // promise settles, and fake timers fire synchronously without flushing it.
    for (let i = 0; i < 3; i++) await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(doFetch.mock.calls.length).toBeGreaterThanOrEqual(3);   // mount + ~3 ticks
    unmount();
  });

  it('slows right down once they log out', async () => {
    const doFetch = vi.fn().mockResolvedValue(1);
    setPilotOnline(false);
    const store = build(doFetch);
    const { unmount } = renderHook(() => store.use());
    for (let i = 0; i < 3; i++) await act(async () => { vi.advanceTimersByTime(10_000); });
    // At the fast rate this window would be ~4 calls; at the slow one it is the
    // mount fetch and nothing else yet.
    expect(doFetch.mock.calls.length).toBeLessThanOrEqual(2);
    unmount();
  });

  it('speeds back up when they come back', async () => {
    const doFetch = vi.fn().mockResolvedValue(1);
    setPilotOnline(false);
    const store = build(doFetch);
    const { unmount } = renderHook(() => store.use());
    // Offline: ~1 tick per minute.
    for (let i = 0; i < 6; i++) await act(async () => { vi.advanceTimersByTime(10_000); });
    const offlineMinute = doFetch.mock.calls.length;
    expect(offlineMinute).toBeLessThanOrEqual(2);              // mount + one tick

    // Coming online cannot cancel the tick already scheduled at the slow rate,
    // so let that one land before measuring — the point is the cadence AFTER.
    act(() => { setPilotOnline(true); });
    for (let i = 0; i < 7; i++) await act(async () => { vi.advanceTimersByTime(10_000); });
    const settled = doFetch.mock.calls.length;

    for (let i = 0; i < 6; i++) await act(async () => { vi.advanceTimersByTime(10_000); });
    const onlineMinute = doFetch.mock.calls.length - settled;
    expect(onlineMinute).toBeGreaterThanOrEqual(5);            // back to ~6/min
    unmount();
  });

  it('keeps polling when a request never settles, at either cadence', async () => {
    // Guards the rewrite from setInterval to a self-scheduling timeout: chaining
    // the next tick off the request settling would wedge the poll forever here.
    const doFetch = vi.fn().mockImplementation(() => new Promise<number>(() => {}));
    setPilotOnline(true);
    const store = build(doFetch);
    const { unmount } = renderHook(() => store.use());
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(doFetch.mock.calls.length).toBeGreaterThan(1);
    unmount();
  });
});
