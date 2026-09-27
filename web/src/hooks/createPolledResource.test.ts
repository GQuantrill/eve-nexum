import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createPolledResource } from './createPolledResource';
import { writeXTab, xTabStorageKey } from './crossTabPoll';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: apiMock }));

describe('createPolledResource cross-tab dedup', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); apiMock.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('skips the network when another tab just fetched', async () => {
    // Stand in for a peer tab having published moments ago.
    writeXTab('/api/things', [{ id: 7 }]);
    apiMock.mockResolvedValue([{ id: 999 }]);
    const { useResource } = createPolledResource<{ id: number }>('/api/things', 60_000);

    const { result, unmount } = renderHook(() => useResource());
    await act(async () => {});
    expect(apiMock).not.toHaveBeenCalled();
    expect(result.current).toEqual([{ id: 7 }]);
    unmount();
  });

  it('fetches for itself when the shared value has gone stale', async () => {
    writeXTab('/api/things2', [{ id: 7 }]);
    vi.setSystemTime(Date.now() + 90_000);           // older than the interval
    apiMock.mockResolvedValue([{ id: 999 }]);
    const { useResource } = createPolledResource<{ id: number }>('/api/things2', 60_000);

    const { unmount } = renderHook(() => useResource());
    await act(async () => {});
    expect(apiMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('publishes what it fetches so peers can skip', async () => {
    apiMock.mockResolvedValue([{ id: 42 }]);
    const { useResource } = createPolledResource<{ id: number }>('/api/things3', 60_000);

    const { unmount } = renderHook(() => useResource());
    await act(async () => {});
    const raw = localStorage.getItem(xTabStorageKey('/api/things3'));
    expect(JSON.parse(raw!).v).toEqual([{ id: 42 }]);
    unmount();
  });

  it('keys per endpoint, so two resources never read each other', async () => {
    writeXTab('/api/alpha', [{ id: 1 }]);
    apiMock.mockResolvedValue([{ id: 2 }]);
    const { useResource } = createPolledResource<{ id: number }>('/api/beta', 60_000);

    const { result, unmount } = renderHook(() => useResource());
    await act(async () => {});
    expect(apiMock).toHaveBeenCalledTimes(1);          // alpha's entry is not beta's
    expect(result.current).toEqual([{ id: 2 }]);
    unmount();
  });
});

// The kills store shares a Map across tabs, which JSON cannot carry — it goes
// over as the row array and is rebuilt. Worth pinning: a silent failure here
// would show as an empty heatmap only in the second tab.
describe('Map round-trip through the cross-tab channel', () => {
  interface Row { systemId: number; kills: number }
  const serialize   = (v: Map<number, Row>) => [...v.values()];
  const deserialize = (j: unknown) => new Map((j as Row[]).map((r) => [r.systemId, r]));

  it('survives being serialised and rebuilt', () => {
    const original = new Map<number, Row>([
      [30000142, { systemId: 30000142, kills: 3 }],
      [30002659, { systemId: 30002659, kills: 11 }],
    ]);
    const rebuilt = deserialize(JSON.parse(JSON.stringify(serialize(original))));
    expect(rebuilt).toBeInstanceOf(Map);
    expect(rebuilt.size).toBe(2);
    expect(rebuilt.get(30000142)).toEqual({ systemId: 30000142, kills: 3 });
    expect([...rebuilt.keys()]).toEqual([...original.keys()]);
  });

  it('an empty map round-trips as an empty map, not as undefined', () => {
    const rebuilt = deserialize(JSON.parse(JSON.stringify(serialize(new Map()))));
    expect(rebuilt instanceof Map && rebuilt.size === 0).toBe(true);
  });
});
