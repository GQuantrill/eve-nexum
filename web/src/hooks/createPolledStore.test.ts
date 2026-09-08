import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createPolledStore } from './createPolledStore';
import { writeXTab } from './crossTabPoll';

// Regression cover for two bugs that made polling unreliable in ways no build or
// lint could catch, and which were only found by measuring a running browser.
describe('createPolledStore', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  // `fetch` has no timeout of its own, so a socket that dies quietly leaves its
  // promise pending forever. The store de-duped on that promise, so every later
  // tick got handed the same dead one and polling stopped for the life of the
  // page -- only a reload brought it back.
  it('keeps polling when a request never settles', async () => {
    const doFetch = vi.fn(() => new Promise<number>(() => { /* never settles */ }));
    const store = createPolledStore<number>({ fetch: doFetch, pollMs: 1_000, empty: 0 });

    const { unmount } = renderHook(() => store.use());
    expect(doFetch).toHaveBeenCalledTimes(1);

    // Inside the watchdog window, ticks correctly de-dupe onto the live request.
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(doFetch).toHaveBeenCalledTimes(1);

    // Past it, the dead request is written off and polling resumes rather than
    // being stuck until a reload.
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(doFetch.mock.calls.length).toBeGreaterThan(1);

    unmount();
  });

  // The cross-tab de-dupe let a lone tab read back the entry it had just
  // published. It publishes at fetch-COMPLETION, a fraction into the interval,
  // so at the next tick that entry was a shade under pollMs old and still
  // counted as fresh -- the tab adopted its own value and skipped every other
  // fetch, quietly polling at half the configured rate.
  it('does not adopt the value it published itself', async () => {
    let n = 0;
    // 200ms of latency is the point: it puts our own publish INSIDE the window.
    const doFetch = vi.fn(() => new Promise<number>((res) => { setTimeout(() => res(++n), 200); }));
    const store = createPolledStore<number>({
      fetch: doFetch, pollMs: 1_000, empty: 0,
      crossTab: { key: 'test:self', serialize: (v) => v, deserialize: (j) => j as number },
    });

    const { unmount } = renderHook(() => store.use());
    await act(async () => { vi.advanceTimersByTime(250); });   // first result lands at 200ms
    expect(doFetch).toHaveBeenCalledTimes(1);

    // Tick at 1000ms: our own entry is only 800ms old, so it still looks "fresh".
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(doFetch).toHaveBeenCalledTimes(2);

    unmount();
  });

  // The other half of that fix: skipping our OWN entry must not break the actual
  // point of the de-dupe, which is not re-fetching what a peer tab just got.
  it('still adopts a fresher value published by another tab', async () => {
    const doFetch = vi.fn(async () => 1);
    const store = createPolledStore<number>({
      fetch: doFetch, pollMs: 1_000, empty: 0,
      crossTab: { key: 'test:peer', serialize: (v) => v, deserialize: (j) => j as number },
    });

    const { unmount } = renderHook(() => store.use());
    await act(async () => { await Promise.resolve(); });
    expect(doFetch).toHaveBeenCalledTimes(1);

    // A peer publishes something newer shortly before our next tick.
    await act(async () => { vi.advanceTimersByTime(900); });
    writeXTab('test:peer', 42);
    await act(async () => { vi.advanceTimersByTime(200); });   // crosses the tick

    expect(doFetch).toHaveBeenCalledTimes(1);   // no network call
    expect(store.peek()).toBe(42);              // and the peer's value was taken

    unmount();
  });

  it('stops polling once the last subscriber unmounts', async () => {
    const doFetch = vi.fn(async () => 1);
    const store = createPolledStore<number>({ fetch: doFetch, pollMs: 1_000, empty: 0 });

    const { unmount } = renderHook(() => store.use());
    await act(async () => { await Promise.resolve(); });
    unmount();

    const before = doFetch.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(doFetch).toHaveBeenCalledTimes(before);
  });
});
