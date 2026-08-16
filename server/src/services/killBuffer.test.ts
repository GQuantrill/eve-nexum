import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The counter keeps module-level state and reads Date.now() for its window, so
// each test gets a fresh module (resetModules) under fake timers pinned to a
// fixed "now". Dynamic import returns the freshly-evaluated module.
const WINDOW = 60 * 60 * 1000; // matches the default heatWindowSeconds (60m)
const MIN = 60 * 1000;

async function load() {
  return import('./killBuffer.js');
}

describe('wormhole kill heat counter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('counts ship vs pod kills per system within the window', async () => {
    const { recordWormholeKill, wormholeKillCounts } = await load();
    const now = Date.now();
    recordWormholeKill(31000123, now, false); // ship
    recordWormholeKill(31000123, now, true);  // pod
    recordWormholeKill(31000123, now, false); // ship
    recordWormholeKill(31000456, now, false); // ship, different WH system

    const counts = wormholeKillCounts(WINDOW);
    expect(counts.get(31000123)).toEqual({ shipKills: 2, podKills: 1 });
    expect(counts.get(31000456)).toEqual({ shipKills: 1, podKills: 0 });
  });

  it('excludes kills older than the window', async () => {
    const { recordWormholeKill, wormholeKillCounts } = await load();
    const now = Date.now();
    recordWormholeKill(31000999, now - 10 * MIN, false); // 10m ago — in window
    recordWormholeKill(31000999, now - 30 * MIN, false); // 30m ago — in window

    // A 45-minute window drops nothing here; a 20-minute window drops the 30m one.
    expect(wormholeKillCounts(45 * MIN).get(31000999)).toEqual({ shipKills: 2, podKills: 0 });
    expect(wormholeKillCounts(20 * MIN).get(31000999)).toEqual({ shipKills: 1, podKills: 0 });
  });

  it('omits systems whose only kills are stale', async () => {
    const { recordWormholeKill, wormholeKillCounts } = await load();
    recordWormholeKill(31000777, Date.now() - 2 * WINDOW, false); // 2h ago, beyond retention
    expect(wormholeKillCounts(WINDOW).has(31000777)).toBe(false);
  });

  it('is empty when no wormhole kills were recorded', async () => {
    const { wormholeKillCounts } = await load();
    expect(wormholeKillCounts(WINDOW).size).toBe(0);
  });
});
