import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../api/client', () => ({ api }));

import {
  scheduleSigRemoval, cancelSigRemoval, flushSigRemovals,
  pendingRemovalIds, subscribeSigRemovals,
} from './sigRemovalQueue';
import type { Signature } from '../types';

const sig = (id: string): Signature => ({
  id, sigId: 'ABC-123', sigType: 'wormhole', name: '', notes: '',
  whType: '', whLeadsTo: '', createdAt: '', updatedAt: '',
});
const MAP = 'map-1', SYS = 'sys-1';

// Cover for the overwrite-paste removals. The grace period used to be a timeout
// owned by the signature pane, so it only fired if the user stayed on that
// system until it elapsed -- and clearing bookmarks means hopping the chain, so
// the normal workflow cancelled the very deletions it had just scheduled and the
// despawned sigs silently survived. The queue owns them instead.
describe('sigRemovalQueue', () => {
  beforeEach(() => { vi.useFakeTimers(); api.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('deletes after the grace period even though nothing is watching that system', () => {
    scheduleSigRemoval(MAP, SYS, sig('row-1'), 10);
    expect(api).not.toHaveBeenCalled();          // still in its grace period

    vi.advanceTimersByTime(10_000);
    expect(api).toHaveBeenCalledWith(
      `/api/maps/${MAP}/systems/${SYS}/signatures/row-1`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('removes at once when the grace period is zero', () => {
    scheduleSigRemoval(MAP, SYS, sig('row-2'), 0);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending removal when the sig comes back in a later paste', () => {
    scheduleSigRemoval(MAP, SYS, sig('row-3'), 10);
    cancelSigRemoval('row-3');
    vi.advanceTimersByTime(60_000);
    expect(api).not.toHaveBeenCalled();
  });

  it('restarts the grace period when the same sig is rescheduled', () => {
    scheduleSigRemoval(MAP, SYS, sig('row-4'), 10);
    vi.advanceTimersByTime(9_000);
    scheduleSigRemoval(MAP, SYS, sig('row-4'), 10);   // re-flagged by another paste
    vi.advanceTimersByTime(9_000);
    expect(api).not.toHaveBeenCalled();               // the first timer must not fire
    vi.advanceTimersByTime(2_000);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('flushes outstanding removals rather than losing them, with keepalive', () => {
    scheduleSigRemoval(MAP, SYS, sig('row-5'), 120);
    flushSigRemovals();
    expect(api).toHaveBeenCalledWith(
      expect.stringContaining('row-5'),
      expect.objectContaining({ method: 'DELETE', keepalive: true }),
    );
  });

  it('reports what is pending for a system, and stops once removed', () => {
    scheduleSigRemoval(MAP, SYS, sig('row-6'), 10);
    expect(pendingRemovalIds(SYS).has('row-6')).toBe(true);
    expect(pendingRemovalIds('other-system').has('row-6')).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(pendingRemovalIds(SYS).has('row-6')).toBe(false);
  });

  it('tells subscribers when a removal is scheduled and when it happens', () => {
    const seen: string[] = [];
    const off = subscribeSigRemovals((e) => seen.push(e.kind));
    scheduleSigRemoval(MAP, SYS, sig('row-7'), 10);
    vi.advanceTimersByTime(10_000);
    off();
    expect(seen).toEqual(['scheduled', 'removed']);
  });

  it('keeps the row for a later paste to re-flag when the delete fails', () => {
    api.mockRejectedValueOnce(new Error('offline'));
    expect(() => {
      scheduleSigRemoval(MAP, SYS, sig('row-8'), 0);
    }).not.toThrow();
  });
});
