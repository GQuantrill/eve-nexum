import { describe, it, expect } from 'vitest';
import { formatBookmarkName, DEFAULT_BOOKMARK_FORMAT } from './signatureBookmark';
import type { Signature } from '../types';

const sig = (over: Partial<Signature> = {}): Signature => ({
  id: 'row-1', sigId: 'ABC-123', sigType: 'wormhole',
  whType: null, whLeadsTo: null, name: '', notes: '', createdAt: null,
  ...over,
} as Signature);

// A C2 hole and a frigate hole, enough for the dest/size tokens.
const WH_TYPES = {
  D364: { dest: 'c2', maxJumpMass: 300_000_000, totalMass: 1_000_000_000 },
  E175: { dest: 'c4', maxJumpMass: 62_000_000,  totalMass: 750_000_000 },
} as never;

describe('formatBookmarkName {dest_type}', () => {
  it('takes the class from the wormhole type when it has one', () => {
    expect(formatBookmarkName('{dest_type}', sig({ whType: 'D364' }), WH_TYPES)).toBe('C2');
  });

  it('falls back to the leads-to while it is still a band', () => {
    // A K162 has no destination of its own, so the band it was scanned as is
    // all anyone knows.
    expect(formatBookmarkName('{dest_type}', sig({ whType: 'K162', whLeadsTo: 'C1-C3' }), WH_TYPES)).toBe('C1-C3');
  });

  it('resolves the system class once the hole has been jumped', () => {
    // The reported bug: after jumping, leads-to becomes a real system and the
    // token used to empty out — losing the class exactly when it is known.
    const jumped = sig({ whType: 'K162', whLeadsTo: 'J110555' });
    expect(formatBookmarkName('{dest_type}', jumped, WH_TYPES)).toBe('');
    expect(formatBookmarkName('{dest_type}', jumped, WH_TYPES, Date.now(), () => 'C3')).toBe('C3');
  });

  it('matches the system name regardless of case or padding', () => {
    const lookup = (n: string) => (n === 'J110555' ? 'C3' : null);
    const jumped = sig({ whType: 'K162', whLeadsTo: '  j110555 ' });
    expect(formatBookmarkName('{dest_type}', jumped, WH_TYPES,
      Date.now(), (n) => lookup(n.trim().toUpperCase()))).toBe('C3');
  });

  it('leaves the token empty when the destination is off the map', () => {
    expect(formatBookmarkName('{dest_type}', sig({ whType: 'K162', whLeadsTo: 'J999999' }),
      WH_TYPES, Date.now(), () => null)).toBe('');
  });

  it('never overrides a type that states its own destination', () => {
    // D364 goes to C2 whatever system sits on the far side.
    expect(formatBookmarkName('{dest_type}', sig({ whType: 'D364', whLeadsTo: 'J110555' }),
      WH_TYPES, Date.now(), () => 'C5')).toBe('C2');
  });

  it('keeps the whole default format tidy either side of a jump', () => {
    const before = sig({ whType: 'K162', whLeadsTo: 'C1-C3' });
    const after  = sig({ whType: 'K162', whLeadsTo: 'J110555' });
    expect(formatBookmarkName(DEFAULT_BOOKMARK_FORMAT, before, WH_TYPES)).toBe('ABC-123 C1-C3');
    expect(formatBookmarkName(DEFAULT_BOOKMARK_FORMAT, after, WH_TYPES, Date.now(), () => 'C3'))
      .toBe('ABC-123 C3');
  });
});
