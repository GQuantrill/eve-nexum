import { describe, it, expect } from 'vitest';
import { offMapReason } from './useOffMapReason';

// Reported: on an alliance map that skips K-space, a pilot in nullsec lost the
// "you are here" box and the signature panel with no word why.
const base = {
  systemClass: 'NS', locked: false, canTrack: true, trackJumps: true,
  orgMap: true, mapSkip: true, mySkip: false,
};

describe('offMapReason', () => {
  it('names the map rule on a corp/alliance map that skips K-space', () => {
    expect(offMapReason(base)).toBe('kspaceMap');
  });

  it('names your own setting on a personal map', () => {
    expect(offMapReason({ ...base, orgMap: false, mapSkip: false, mySkip: true })).toBe('kspaceYou');
  });

  it('ignores your own setting where the map decides', () => {
    expect(offMapReason({ ...base, mapSkip: false, mySkip: true })).toBeNull();
  });

  it('says nothing in J-space or Pochven, which are always tracked', () => {
    expect(offMapReason({ ...base, systemClass: 'C3' })).toBeNull();
    expect(offMapReason({ ...base, systemClass: 'Pochven' })).toBeNull();
  });

  it('puts locked, read-only and tracking-off ahead of the K-space rule', () => {
    expect(offMapReason({ ...base, locked: true })).toBe('locked');
    expect(offMapReason({ ...base, canTrack: false })).toBe('readOnly');
    expect(offMapReason({ ...base, trackJumps: false })).toBe('trackingOff');
  });
});
