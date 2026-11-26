import { describe, it, expect } from 'vitest';
import { connLifetimeAction } from './connLifetimeSweep.js';

const H = 3_600_000;
const GRACE = 2 * H;

// A base row: a Q003 (4.5h frig hole) created `ageH` hours ago.
function q003(ageH: number, over: Partial<Parameters<typeof connLifetimeAction>[0]> = {}) {
  return {
    timeStatus: null as string | null,
    whType: 'Q003',
    eolAt: null as Date | string | null,
    lifetimeExpiresAt: null as Date | string | null,
    createdAt: new Date(Date.now() - ageH * H),
    lazyRemove: false,
    ...over,
  };
}

describe('connLifetimeAction', () => {
  const now = Date.now();

  it('does nothing to a young connection with no lifetime of its own', () => {
    const row = { timeStatus: null, whType: null, eolAt: null, lifetimeExpiresAt: null, createdAt: new Date(now - 23 * H), lazyRemove: true };
    expect(connLifetimeAction(row, now, GRACE)).toEqual({ kind: 'none' });
  });

  it('an untyped connection is severed (never collapsed) at 24h plus grace', () => {
    const row = (lazyRemove: boolean, ageH: number, whType: string | null = null) =>
      ({ timeStatus: null, whType, eolAt: null, lifetimeExpiresAt: null, createdAt: new Date(now - ageH * H), lazyRemove });
    expect(connLifetimeAction(row(true, 25), now, GRACE)).toEqual({ kind: 'none' });   // within grace
    expect(connLifetimeAction(row(true, 27), now, GRACE)).toEqual({ kind: 'sever' });
    expect(connLifetimeAction(row(false, 27), now, GRACE)).toEqual({ kind: 'sever' });
    expect(connLifetimeAction(row(true, 60, 'ZZZ9'), now, GRACE)).toEqual({ kind: 'sever' }); // unknown code
  });

  it('a manual override past the ceiling keeps an untyped connection alive', () => {
    const row = { timeStatus: null, whType: null, eolAt: null, lifetimeExpiresAt: new Date(now + 5 * H),
      createdAt: new Date(now - 60 * H), lazyRemove: true };
    expect(connLifetimeAction(row, now, GRACE).kind).not.toMatch(/collapse|sever/);
  });

  it('does nothing when the stored bucket already matches', () => {
    // 1h-old Q003 → ~3.5h left → lessThan4h; stored already lessThan4h.
    expect(connLifetimeAction(q003(1, { timeStatus: 'lessThan4h' }), now, GRACE)).toEqual({ kind: 'none' });
  });

  it('re-buckets when the stored status has drifted', () => {
    // fresh Q003 stored as fresh, but 4.5h hole opens at lessThan24h.
    expect(connLifetimeAction(q003(0, { timeStatus: 'fresh' }), now, GRACE))
      .toEqual({ kind: 'rebucket', bucket: 'lessThan24h' });
  });

  it('marks an expired hole expired (not collapse) when the map has not opted in', () => {
    // 5h-old Q003 (expired ~0.5h ago), lazyRemove off.
    expect(connLifetimeAction(q003(5, { lazyRemove: false }), now, GRACE))
      .toEqual({ kind: 'rebucket', bucket: 'expired' });
  });

  it('does not collapse within the grace period even on an opt-in map', () => {
    // expired ~0.5h ago, grace 2h → still just expired.
    expect(connLifetimeAction(q003(5, { lazyRemove: true, timeStatus: 'lessThan1h' }), now, GRACE))
      .toEqual({ kind: 'rebucket', bucket: 'expired' });
  });

  it('does nothing extra once expired and already stored expired, within grace', () => {
    expect(connLifetimeAction(q003(5, { lazyRemove: true, timeStatus: 'expired' }), now, GRACE))
      .toEqual({ kind: 'none' });
  });

  it('only severs an expired hole past grace when the map has not opted in', () => {
    expect(connLifetimeAction(q003(7, { lazyRemove: false, timeStatus: 'expired' }), now, GRACE))
      .toEqual({ kind: 'sever' });
  });

  it('collapses once expired past the grace period on an opt-in map', () => {
    // 7h-old Q003 → expired ~2.5h ago > 2h grace.
    expect(connLifetimeAction(q003(7, { lazyRemove: true, timeStatus: 'expired' }), now, GRACE))
      .toEqual({ kind: 'collapse' });
  });

  it('a manual override drives collapse timing, not the type age', () => {
    // A 48h B041 hole, but manually set to have expired 3h ago → past grace.
    const row = {
      timeStatus: 'expired' as string | null,
      whType: 'B041',
      eolAt: null as Date | string | null,
      lifetimeExpiresAt: new Date(Date.now() - 3 * H),
      createdAt: new Date(Date.now() - 1 * H),
      lazyRemove: true,
    };
    expect(connLifetimeAction(row, now, GRACE)).toEqual({ kind: 'collapse' });
  });
});
