import { describe, it, expect, beforeEach, vi } from 'vitest';

// Spy on what a processed killmail is counted into, and keep the DB-touching
// side (map publishing, Discord) out of the way.
const pvp = vi.hoisted(() => ({ recorded: [] as Array<[number, number]> }));
vi.mock('./pvpHistory.js', () => ({
  recordPvpKill: (sys: number, at: number) => { pvp.recorded.push([sys, at]); },
  flushPvpKills: async () => {},
}));
vi.mock('./mapEvents.js', () => ({ activeMapIds: () => [], publishToMap: () => {} }));
vi.mock('./discord.js', () => ({ notifyDiscord: async () => {}, killEmbed: () => ({}) }));
vi.mock('./appSettings.js', () => ({ getSetting: async () => null, setSetting: async () => {} }));

import { planStart, processKill } from './killFeed.js';
import { recentKillsForSystems } from './killBuffer.js';
import { config } from '../config.js';

describe('planStart', () => {
  it('with no saved position, reads back over the backfill window as a replay', () => {
    expect(planStart(1_000_000, 997_000, null)).toEqual({ start: 997_000, replayUntil: 999_999 });
  });

  it('resumes just after the saved position when that is earlier than the window', () => {
    // Down for longer than the window: pick up every killmail since we stopped.
    expect(planStart(1_000_000, 997_000, 990_000)).toEqual({ start: 990_001, replayUntil: 990_000 });
  });

  it('still reads the whole window when the saved position is recent', () => {
    // A quick restart: replay the window to refill memory; only what came after
    // the saved position is new.
    expect(planStart(1_000_000, 997_000, 999_500)).toEqual({ start: 997_000, replayUntil: 999_500 });
  });

  it('never replays more than a day or so after a long outage', () => {
    const plan = planStart(1_000_000, 997_000, 10);
    expect(plan.start).toBe(1_000_000 - 30_000);
    expect(plan.replayUntil).toBe(10);
  });

  it('ignores a saved position at or past the head (R2Z2 was reset)', () => {
    expect(planStart(1_000, 900, 5_000)).toEqual({ start: 900, replayUntil: 999 });
  });
});

let nextId = 9_000_000_000;
function kill(over: { value?: number; npc?: boolean; system?: number; attackers?: number } = {}) {
  const id = nextId++;
  return {
    killmail_id: id,
    uploaded_at: Math.floor(Date.now() / 1000),
    zkb: { totalValue: over.value ?? 12_000, npc: over.npc ?? false, solo: false },
    esi: {
      killmail_id: id,
      killmail_time: new Date().toISOString(),
      solar_system_id: over.system ?? 30000142,
      victim: { ship_type_id: 670, character_id: 9001, corporation_id: 98001, alliance_id: 99001 },
      attackers: Array.from({ length: over.attackers ?? 2 }, (_, i) => ({
        character_id: 8000 + i, corporation_id: 98100, alliance_id: 99100, ship_type_id: 587, final_blow: i === 0,
      })),
    },
  };
}

describe('processKill', () => {
  beforeEach(() => { pvp.recorded = []; });

  it('buffers a kill below the ISK floor, for the killboard pane', async () => {
    const k = kill({ value: 12_000, system: 31000001 });
    await processKill(k);
    const got = recentKillsForSystems(new Set([31000001]), 10);
    expect(got.map((b) => b.killmailId)).toContain(k.killmail_id);
    const b = got.find((x) => x.killmailId === k.killmail_id)!;
    expect(b).toMatchObject({ victimAllianceId: 99001, finalBlowAllianceId: 99100, attackerCount: 2 });
    // ...but the kill log, which applies the floor, leaves it out.
    expect(recentKillsForSystems(new Set([31000001]), 10, config.killFeed.minValueIsk)
      .some((x) => x.killmailId === k.killmail_id)).toBe(false);
  });

  it('counts a player kill into the PvP history, but not an NPC one', async () => {
    await processKill(kill({ system: 31000002 }));
    await processKill(kill({ system: 31000002, npc: true }));
    expect(pvp.recorded.filter(([s]) => s === 31000002)).toHaveLength(1);
  });

  it('buffers a replayed killmail but does not count it again', async () => {
    const k = kill({ system: 31000003 });
    await processKill(k, true);
    expect(pvp.recorded).toHaveLength(0);
    expect(recentKillsForSystems(new Set([31000003]), 10).map((b) => b.killmailId)).toContain(k.killmail_id);
  });

  it('handles each killmail once', async () => {
    const k = kill({ system: 31000004 });
    await processKill(k);
    await processKill(k);
    expect(pvp.recorded.filter(([s]) => s === 31000004)).toHaveLength(1);
  });
});
