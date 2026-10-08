import { describe, it, expect } from 'vitest';
import { sigSortKey } from './sigSort';
import type { Signature } from '../types';

const sig = (over: Partial<Record<string, unknown>> = {}) =>
  ({ sigType: 'data', name: '', ...over }) as unknown as Signature;

const sortBy = (list: Signature[], col: string, dir: 'asc' | 'desc' = 'asc') =>
  [...list].sort((a, b) => {
    const c = sigSortKey(a, col).toLowerCase().localeCompare(sigSortKey(b, col).toLowerCase());
    return dir === 'asc' ? c : -c;
  });

describe('sigSortKey, Group column', () => {
  it('puts unscanned signatures first, as the game does', () => {
    // 'unknown' would otherwise sort between ore and wormhole, burying the
    // sigs still to be scanned under a pile of gas.
    const list = [sig({ sigType: 'gas' }), sig({ sigType: 'unknown' }), sig({ sigType: 'wormhole' })];
    expect(sortBy(list, 'sigType').map((s) => s.sigType)).toEqual(['unknown', 'gas', 'wormhole']);
  });

  it('puts them last descending, also as the game does', () => {
    // Blank sorts to the opposite end when reversed; it is not pinned.
    const list = [sig({ sigType: 'gas' }), sig({ sigType: 'unknown' }), sig({ sigType: 'wormhole' })];
    expect(sortBy(list, 'sigType', 'desc').map((s) => s.sigType)).toEqual(['wormhole', 'gas', 'unknown']);
  });

  it('leaves the other groups in alphabetical order', () => {
    const list = ['wormhole', 'combat', 'relic', 'data'].map((t) => sig({ sigType: t }));
    expect(sortBy(list, 'sigType').map((s) => s.sigType)).toEqual(['combat', 'data', 'relic', 'wormhole']);
  });
});

describe('sigSortKey, other columns', () => {
  it('sorts a ghost row on its tier, not its blank wormhole type', () => {
    expect(sigSortKey(sig({ sigType: 'ghost', name: 'Superior Blood Covert Research Facility' }), 'whType'))
      .toBe('Superior');
  });

  it('keeps unknown as a real value outside the Group column', () => {
    // Only the Group column treats it as blank; elsewhere it is just a string.
    expect(sigSortKey(sig({ sigType: 'unknown', name: 'Zed' }), 'name')).toBe('Zed');
  });

  it('is blank for a missing field rather than throwing', () => {
    expect(sigSortKey(sig(), 'notes')).toBe('');
  });
});
