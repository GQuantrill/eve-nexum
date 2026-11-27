import { describe, it, expect } from 'vitest';
import { formatBookmarkName } from './signatureBookmark';
import type { Signature } from '../types';
import type { WormholeSpec } from '../hooks/useWormholeTypes';

const types = { B274: { maxJumpMass: 375_000_000 } } as unknown as Record<string, WormholeSpec>;
const sig = (over: Partial<Signature>) => ({ id: 's', sigId: 'ABC-123', whType: 'B274', ...over }) as Signature;

describe('bookmark {size}', () => {
  it('uses the size the type implies when none is logged', () => {
    expect(formatBookmarkName('{size}', sig({}), types)).toBe('L');
  });
  it('uses the logged size over the type', () => {
    expect(formatBookmarkName('{size}', sig({ whSize: 'medium' }), types)).toBe('M');
  });
  it('fills a K162 from the logged size', () => {
    expect(formatBookmarkName('{size}', sig({ whType: 'K162', whSize: 'xl' }), types)).toBe('XL');
  });
});
