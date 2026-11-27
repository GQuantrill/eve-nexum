import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
vi.mock('../db.js', () => ({ db: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('./blueLoot.js', () => ({ blueLootSystems: async () => new Map() }));

const { serverKindTargets, resetNearestSetsForTest } = await import('./nearestSets.js');

const stations = (...ids: number[]) => ({ rows: ids.map((solar_system_id) => ({ solar_system_id })) });

beforeEach(() => {
  resetNearestSetsForTest();
  query.mockReset();
  // The k-space system list (loaded once), then whatever the test queues.
  query.mockResolvedValueOnce({ rows: [] });
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('serverKindTargets cache', () => {
  it('reads a kind once, then again after ten minutes', async () => {
    query.mockResolvedValueOnce(stations(1, 2)).mockResolvedValueOnce(stations(3));
    expect([...(await serverKindTargets('station')).ids]).toEqual([1, 2]);
    expect([...(await serverKindTargets('station')).ids]).toEqual([1, 2]);
    expect(query).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect([...(await serverKindTargets('station')).ids]).toEqual([3]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('does not keep a failed read', async () => {
    query.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(stations(5));
    await expect(serverKindTargets('concord')).rejects.toThrow('db down');
    expect([...(await serverKindTargets('concord')).ids]).toEqual([5]);
  });
});
