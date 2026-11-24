import { describe, it, expect } from 'vitest';
import { forwardChainLabel, withChain, labelParts, CHAIN_LABEL_RE, sigChainState, numberAllOrder } from './chainNumber';
import { formatBookmarkName } from './signatureBookmark';
import type { Signature } from '../types';

describe('chain numbers in bookmarks', () => {
  it('gives a hole the number of where it leads, one step further from home', () => {
    expect(forwardChainLabel({ isHome: true }, { chainLabel: '5' })).toBe('5');
    expect(forwardChainLabel({ chainLabel: '51' }, { chainLabel: '516' })).toBe('516');
    expect(forwardChainLabel({ chainLabel: '5' }, { chainLabel: '5.10' })).toBe('5.10');
  });

  it('leaves the way back, side links and unnumbered systems without one', () => {
    expect(forwardChainLabel({ chainLabel: '51' }, { chainLabel: '5' })).toBe('');
    expect(forwardChainLabel({ chainLabel: '51' }, { chainLabel: '521' })).toBe('');
    expect(forwardChainLabel({ chainLabel: null }, { chainLabel: '51' })).toBe('');
    expect(forwardChainLabel({ chainLabel: '5' }, undefined)).toBe('');
  });

  it('puts {chain} in front when the map numbers chains and the format leaves it out', () => {
    expect(withChain('{sig} {dest_type}', true)).toBe('{chain} {sig} {dest_type}');
    expect(withChain('{sig} {chain}', true)).toBe('{sig} {chain}');
    expect(withChain('{sig}', false)).toBe('{sig}');
    const sig = { sigId: 'ABC-123', whType: 'D382', whLeadsTo: '' } as Signature;
    expect(formatBookmarkName('{chain} {sig_letters}', sig, {}, 0, undefined, undefined, '516')).toBe('516 ABC');
    expect(formatBookmarkName('{chain} {sig_letters}', sig)).toBe('ABC');
  });

  it('reads labels the way the server writes them', () => {
    expect(labelParts('5.10.1')).toEqual([5, 10, 1]);
    expect(CHAIN_LABEL_RE.test('5162')).toBe(true);
    expect(CHAIN_LABEL_RE.test('51a')).toBe(false);
  });
});

describe('reserving chain numbers before the jump', () => {
  const home = { isHome: true, chainLabel: null };
  const five = { isHome: false, chainLabel: '5' };
  const wh = (chainLabel: string | null = null) => ({ sigType: 'wormhole', chainLabel });

  it('offers +1 on an unjumped hole out of home or a numbered system', () => {
    expect(sigChainState(wh(), home, undefined, true)).toEqual({ kind: 'reserve' });
    expect(sigChainState(wh(), five, undefined, true)).toEqual({ kind: 'reserve' });
    // An unnumbered far system on the map can still take one.
    expect(sigChainState(wh(), home, { isHome: false, chainLabel: null }, true)).toEqual({ kind: 'reserve' });
  });

  it('shows a reserved number until the jump, then the system\'s', () => {
    expect(sigChainState(wh('2'), home, undefined, true)).toEqual({ kind: 'number', label: '2', reserved: true });
    expect(sigChainState(wh('2'), home, { chainLabel: '2' }, true)).toEqual({ kind: 'number', label: '2', reserved: false });
    expect(sigChainState(wh('51'), five, undefined, true)).toEqual({ kind: 'number', label: '51', reserved: true });
    // A reservation that no longer fits its system (renumbered) is ignored.
    expect(sigChainState(wh('3'), five, undefined, true)).toEqual({ kind: 'reserve' });
  });

  it('offers nothing where there is nothing to number', () => {
    expect(sigChainState(wh(), home, undefined, false)).toEqual({ kind: 'none' });
    expect(sigChainState({ sigType: 'data', chainLabel: null }, home, undefined, true)).toEqual({ kind: 'none' });
    expect(sigChainState(wh(), { isHome: false, chainLabel: null }, undefined, true)).toEqual({ kind: 'none' });
    // The way back home, and a side link to a numbered system.
    expect(sigChainState(wh(), five, home, true)).toEqual({ kind: 'none' });
    expect(sigChainState(wh(), five, { chainLabel: '3' }, true)).toEqual({ kind: 'none' });
  });

  it('numbers statics first, then by signature ID', () => {
    const sigs = [
      { id: 'a', sigId: 'FWB-860', whType: 'E175' },
      { id: 'b', sigId: 'AFU-536', whType: 'K162' },
      { id: 'c', sigId: 'XIJ-939', whType: 'H296' },
    ];
    expect(numberAllOrder(sigs, ['H296']).map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });
});
