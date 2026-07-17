import { describe, it, expect } from 'vitest';
import { lifeBucket, effectiveExpiryMs, whLifetimeHours } from './whLifetimes.js';

const H = 3_600_000;

describe('lifeBucket', () => {
  it('maps remaining time to the right bucket', () => {
    expect(lifeBucket(30 * H)).toBe('fresh');        // > 24h
    expect(lifeBucket(24 * H)).toBe('lessThan24h');  // exactly a day → decaying
    expect(lifeBucket(5 * H)).toBe('lessThan24h');
    expect(lifeBucket(4 * H)).toBe('lessThan4h');    // exactly 4h → EOL window
    expect(lifeBucket(2 * H)).toBe('lessThan4h');
    expect(lifeBucket(1 * H)).toBe('lessThan1h');    // exactly 1h
    expect(lifeBucket(30 * 60 * 1000)).toBe('lessThan1h');
    expect(lifeBucket(0)).toBe('expired');
    expect(lifeBucket(-1)).toBe('expired');
    // Boundaries are inclusive of the shorter bucket.
    expect(lifeBucket(24 * H + 1)).toBe('fresh');
    expect(lifeBucket(4 * H + 1)).toBe('lessThan24h');
    expect(lifeBucket(1 * H + 1)).toBe('lessThan4h');
  });
});

describe('effectiveExpiryMs', () => {
  const created = new Date('2026-01-01T00:00:00Z');
  const createdMs = created.getTime();

  it('auto: createdAt + charted max life for a known non-K162 code', () => {
    // M609 is a 16h hole.
    const exp = effectiveExpiryMs({ lifetimeExpiresAt: null, eolAt: null, whType: 'M609', createdAt: created });
    expect(exp).toBe(createdMs + 16 * H);
  });

  it('a 16h hole is "< 1 day" at open and "< 4h" after 12h', () => {
    const exp = effectiveExpiryMs({ lifetimeExpiresAt: null, eolAt: null, whType: 'M609', createdAt: created })!;
    expect(lifeBucket(exp - createdMs)).toBe('lessThan24h');              // at open: 16h left
    expect(lifeBucket(exp - (createdMs + 12 * H))).toBe('lessThan4h');    // after 12h: 4h left
  });

  it('a fresh 24h static opens at "< 1 day", never "fresh"', () => {
    const exp = effectiveExpiryMs({ lifetimeExpiresAt: null, eolAt: null, whType: 'A239', createdAt: created })!;
    expect(whLifetimeHours('A239')).toBe(24);
    expect(lifeBucket(exp - createdMs)).toBe('lessThan24h');
  });

  it('a 48h hole opens "fresh"', () => {
    const exp = effectiveExpiryMs({ lifetimeExpiresAt: null, eolAt: null, whType: 'B041', createdAt: created })!;
    expect(whLifetimeHours('B041')).toBe(48);
    expect(lifeBucket(exp - createdMs)).toBe('fresh');
  });

  it('untyped / unrecognised has no computable expiry', () => {
    expect(effectiveExpiryMs({ lifetimeExpiresAt: null, eolAt: null, whType: null, createdAt: created })).toBeNull();
    expect(effectiveExpiryMs({ lifetimeExpiresAt: null, eolAt: null, whType: '', createdAt: created })).toBeNull();
    expect(effectiveExpiryMs({ lifetimeExpiresAt: null, eolAt: null, whType: 'ZZZ9', createdAt: created })).toBeNull();
  });

  it('a bare K162 decays against the 48h ceiling and opens fresh', () => {
    expect(whLifetimeHours('K162')).toBe(48);
    const exp = effectiveExpiryMs({ lifetimeExpiresAt: null, eolAt: null, whType: 'K162', createdAt: created })!;
    expect(exp).toBe(createdMs + 48 * H);
    expect(lifeBucket(exp - createdMs)).toBe('fresh');
  });

  it('manual override wins over the auto estimate', () => {
    const override = new Date('2026-01-02T00:00:00Z');
    const exp = effectiveExpiryMs({ lifetimeExpiresAt: override, eolAt: null, whType: 'M609', createdAt: created });
    expect(exp).toBe(override.getTime());
  });

  it('a legacy eol_at mark ages as a 4h window from when it was set', () => {
    const eol = new Date('2026-01-01T10:00:00Z');
    const exp = effectiveExpiryMs({ lifetimeExpiresAt: null, eolAt: eol, whType: 'M609', createdAt: created });
    expect(exp).toBe(eol.getTime() + 4 * H);
  });
});
