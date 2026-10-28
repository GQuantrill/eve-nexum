import { describe, it, expect } from 'vitest';
import { countPersonalMaps } from './personalMaps';
import type { MapListItem } from '../store/mapStore';

const map = (over: Partial<MapListItem>): MapListItem => ({ id: 'x', name: 'x', isCorpMap: false, ...over } as MapListItem);

describe('countPersonalMaps', () => {
  it('counts only maps the caller owns', () => {
    expect(countPersonalMaps([
      map({}), map({}), map({}), map({}),
      map({ isCorpMap: true }),
      map({ isAllianceMap: true }),
      map({ sharedWithMe: true }),
      // Shared and hidden from the switcher: still someone else's map.
      map({ sharedWithMe: true, hiddenByMe: true }),
    ])).toBe(4);
  });
});
