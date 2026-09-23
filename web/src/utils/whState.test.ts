import { describe, it, expect } from 'vitest';
import { LIFE_CYCLE, lifePatch } from './whState';
import { lifeBucket } from './whLifetime';
import type { MapConnection, TimeStatus } from '../types';

const conn = (type: string | null = null) => ({ type } as Pick<MapConnection, 'type'>);
const cycle = <T,>(list: T[], current: T): T => list[(list.indexOf(current) + 1) % list.length];

describe('LIFE_CYCLE', () => {
  it('steps through unknown, the three warnings, then expired, then back', () => {
    const seen: Array<TimeStatus | ''> = [];
    let at: TimeStatus | '' = '';
    for (let i = 0; i < LIFE_CYCLE.length; i++) { at = cycle(LIFE_CYCLE, at); seen.push(at); }
    expect(seen).toEqual(['lessThan24h', 'lessThan4h', 'lessThan1h', 'expired', '']);
  });
});

describe('lifePatch', () => {
  // A bucket is derived from the expiry, so the test of "did marking it work"
  // is what the expiry buckets back to — not what was stored alongside it.
  const bucketOf = (patch: Partial<MapConnection>) =>
    lifeBucket(new Date(patch.lifetimeExpiresAt as string).getTime() - Date.now());

  it('marks expired as an expiry already in the past', () => {
    const patch = lifePatch('expired', conn('K162'));
    expect(new Date(patch.lifetimeExpiresAt as string).getTime()).toBeLessThan(Date.now());
    expect(bucketOf(patch)).toBe('expired');
  });

  it('does not mistake expired (0 hours) for a clear back to unknown', () => {
    // The trap: 0 is falsy, so a truthiness check would send 'expired' down the
    // reset path and restore the hole's FULL life instead of ending it.
    const patch = lifePatch('expired', conn('K162'));
    expect(patch.timeStatus).toBe('expired');
    expect(bucketOf(patch)).not.toBe('fresh');
  });

  it('still lands each warning inside its own bucket', () => {
    expect(bucketOf(lifePatch('lessThan24h', conn('K162')))).toBe('lessThan24h');
    expect(bucketOf(lifePatch('lessThan4h',  conn('K162')))).toBe('lessThan4h');
    expect(bucketOf(lifePatch('lessThan1h',  conn('K162')))).toBe('lessThan1h');
  });

  it('clearing to unknown restores a known hole to its full life', () => {
    const patch = lifePatch('', conn('D382'), { D382: { lifetimeHours: 48 } });
    expect(patch.timeStatus).toBe('fresh');
    expect(bucketOf(patch)).toBe('fresh');
  });

  it('clearing a K162 leaves it in the 24h band, because that IS its full life', () => {
    // Not a bug: a K162 lives at most 24h, so a brand-new one is already inside
    // the <24h bucket. The derived bucket wins over the stored 'fresh'.
    const patch = lifePatch('', conn('K162'));
    expect(patch.timeStatus).toBe('fresh');
    expect(bucketOf(patch)).toBe('lessThan24h');
  });

  it('marks expired exactly as the connection panel does', () => {
    // The panel writes { timeStatus: 'expired', eolAt: null, lifetimeExpiresAt:
    // now + 0h }. The chip must land on the same state, or the same hole reads
    // differently depending on which of the two you used.
    const panel = { timeStatus: 'expired', eolAt: null, lifetimeExpiresAt: new Date(Date.now()).toISOString() };
    const chip  = lifePatch('expired', conn('K162'));
    expect(chip.timeStatus).toBe(panel.timeStatus);
    expect(chip.eolAt).toBe(panel.eolAt);
    expect(bucketOf(chip)).toBe(lifeBucket(new Date(panel.lifetimeExpiresAt).getTime() - Date.now()));
  });

  it('clearing an untyped hole just drops the manual expiry', () => {
    expect(lifePatch('', conn(null))).toEqual({ timeStatus: 'fresh', eolAt: null, lifetimeExpiresAt: null });
  });
});
