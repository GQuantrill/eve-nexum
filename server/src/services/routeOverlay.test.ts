import { describe, it, expect } from 'vitest';
import { isPastLife } from './routeOverlay.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-12T12:00:00Z');

/** A connection as the overlay query returns it. C247 lives 24h. */
const conn = (over: Partial<Parameters<typeof isPastLife>[0]> = {}) => ({
  lifetimeExpiresAt: null as Date | null,
  eolAt:             null as Date | null,
  whType:            'C247',
  createdAt:         new Date(NOW - 2 * HOUR),
  graceHours:        4,
  ...over,
});

describe('isPastLife', () => {
  it('routes through a hole that is still alive', () => {
    expect(isPastLife(conn(), NOW)).toBe(false);
  });

  it('still routes through one only just past its estimate', () => {
    // The estimate is the type's maximum, and a hole can outlive it slightly —
    // which is exactly what the map's collapse grace exists to absorb. Dropping
    // the edge the instant the clock ticks over would strand people mid-chain.
    expect(isPastLife(conn({ lifetimeExpiresAt: new Date(NOW - 1 * HOUR) }), NOW)).toBe(false);
    expect(isPastLife(conn({ lifetimeExpiresAt: new Date(NOW - 3.9 * HOUR) }), NOW)).toBe(false);
  });

  it('drops one past its estimate by more than the map grace', () => {
    expect(isPastLife(conn({ lifetimeExpiresAt: new Date(NOW - 5 * HOUR) }), NOW)).toBe(true);
  });

  it('honours each map s own grace rather than a fixed one', () => {
    const dead = { lifetimeExpiresAt: new Date(NOW - 5 * HOUR) };
    expect(isPastLife(conn({ ...dead, graceHours: 1 }),  NOW)).toBe(true);
    expect(isPastLife(conn({ ...dead, graceHours: 12 }), NOW)).toBe(false);
  });

  it('ages a typed hole out from its creation time', () => {
    // No explicit expiry recorded: a C247 is a 24h hole, so one created 30h ago
    // is 6h dead — past a 4h grace.
    expect(isPastLife(conn({ createdAt: new Date(NOW - 30 * HOUR) }), NOW)).toBe(true);
    expect(isPastLife(conn({ createdAt: new Date(NOW - 20 * HOUR) }), NOW)).toBe(false);
  });

  it('keeps a recent untyped hole, so a hand-drawn chain still routes', () => {
    const untyped = { whType: null, createdAt: new Date(NOW - 6 * HOUR) };
    expect(isPastLife(conn(untyped), NOW)).toBe(false);
  });

  it('drops an untyped hole past the 48h ceiling no wormhole outlives', () => {
    // The real report: an untyped 'standard' connection 77h old was still
    // routing, because nothing could compute an expiry for it. It does have a
    // knowable ceiling though — a K162 is aged the same way for the same
    // reason — so past it the hole cannot be open whatever it turned out to be.
    expect(isPastLife(conn({ whType: null, createdAt: new Date(NOW - 77 * HOUR) }), NOW)).toBe(true);
  });

  it('puts the untyped cutoff at the ceiling plus the map grace', () => {
    const at = (h: number, graceHours = 0.5) =>
      isPastLife(conn({ whType: null, createdAt: new Date(NOW - h * HOUR), graceHours }), NOW);
    expect(at(48)).toBe(false);    // exactly the ceiling, grace still to run
    expect(at(48.4)).toBe(false);  // inside the default 30-minute grace
    expect(at(48.6)).toBe(true);   // past it
  });

  it('ages a legacy eol mark out, allowing for the EOL window itself', () => {
    // An eol_at mark means ~4h of life remained at that moment, so the hole is
    // dead 4h after the mark — then the grace on top.
    expect(isPastLife(conn({ whType: null, eolAt: new Date(NOW - 2 * HOUR) }), NOW)).toBe(false);
    expect(isPastLife(conn({ whType: null, eolAt: new Date(NOW - 12 * HOUR) }), NOW)).toBe(true);
  });
});
