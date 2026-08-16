import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The counter keeps module-level state and reads Date.now() for its window, so
// each test gets a fresh module (resetModules) under fake timers pinned to a
// fixed "now". Dynamic import returns the freshly-evaluated module.
const WINDOW = 60 * 60 * 1000; // matches the default heatWindowSeconds (60m)
const MIN = 60 * 1000;

async function load() {
  return import('./killBuffer.js');
}

describe('live kill heat counter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('counts ship / pod / npc kills per system within the window', async () => {
    const { recordLiveKill, liveKillCounts } = await load();
    const now = Date.now();
    // A wormhole system and a k-space system — the counter is source-agnostic.
    recordLiveKill(31000123, now, 'ship');
    recordLiveKill(31000123, now, 'pod');
    recordLiveKill(31000123, now, 'ship');
    recordLiveKill(31000123, now, 'npc');
    recordLiveKill(30000142, now, 'ship'); // Jita (k-space)

    const counts = liveKillCounts(WINDOW);
    expect(counts.get(31000123)).toEqual({ shipKills: 2, podKills: 1, npcKills: 1 });
    expect(counts.get(30000142)).toEqual({ shipKills: 1, podKills: 0, npcKills: 0 });
  });

  it('excludes kills older than the window', async () => {
    const { recordLiveKill, liveKillCounts } = await load();
    const now = Date.now();
    recordLiveKill(31000999, now - 10 * MIN, 'ship'); // 10m ago
    recordLiveKill(31000999, now - 30 * MIN, 'ship'); // 30m ago

    // A 45-minute window keeps both; a 20-minute window drops the 30m one.
    expect(liveKillCounts(45 * MIN).get(31000999)).toEqual({ shipKills: 2, podKills: 0, npcKills: 0 });
    expect(liveKillCounts(20 * MIN).get(31000999)).toEqual({ shipKills: 1, podKills: 0, npcKills: 0 });
  });

  it('omits systems whose only kills are stale', async () => {
    const { recordLiveKill, liveKillCounts } = await load();
    recordLiveKill(31000777, Date.now() - 2 * WINDOW, 'ship'); // 2h ago, beyond retention
    expect(liveKillCounts(WINDOW).has(31000777)).toBe(false);
  });

  it('is empty when no kills were recorded', async () => {
    const { liveKillCounts } = await load();
    expect(liveKillCounts(WINDOW).size).toBe(0);
  });
});
