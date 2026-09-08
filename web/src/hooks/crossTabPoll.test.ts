import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readXTab, writeXTab, xTabStorageKey } from './crossTabPoll';

// The cross-tab cache underpins every poll's de-duplication, so its freshness
// rule decides how often the app talks to the server at all. A window that is
// wrong in either direction is expensive: too generous and tabs serve stale
// locations, too strict and the de-dupe stops saving any requests.
describe('crossTabPoll', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('round-trips a value with the time it was published', () => {
    vi.setSystemTime(5_000);
    writeXTab('k', { hello: 'world' });
    const e = readXTab('k', 10_000);
    expect(e?.v).toEqual({ hello: 'world' });
    // The publish time, not the read time -- an adopting tab must age the value
    // from when the PEER fetched it or a nearly-stale value looks brand new.
    expect(e?.at).toBe(5_000);
  });

  it('treats a value as fresh strictly INSIDE the window', () => {
    vi.setSystemTime(0);
    writeXTab('k', 1);
    vi.setSystemTime(9_999);
    expect(readXTab('k', 10_000)).toBeDefined();
    vi.setSystemTime(10_000);            // exactly at the window: already stale
    expect(readXTab('k', 10_000)).toBeUndefined();
  });

  it('returns nothing for a key that was never published', () => {
    expect(readXTab('missing', 10_000)).toBeUndefined();
  });

  it('degrades to undefined rather than throwing on a corrupt entry', () => {
    localStorage.setItem(xTabStorageKey('k'), '{not json');
    expect(readXTab('k', 10_000)).toBeUndefined();
  });

  it('ignores an entry with no usable timestamp', () => {
    localStorage.setItem(xTabStorageKey('k'), JSON.stringify({ v: 1 }));
    expect(readXTab('k', 10_000)).toBeUndefined();
  });

  it('namespaces its keys so it cannot collide with other stored settings', () => {
    expect(xTabStorageKey('location:1')).toBe('nexum.xpoll.location:1');
  });
});
