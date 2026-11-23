import { describe, it, expect } from 'vitest';
import { forwardChainLabel, withChain, labelParts, CHAIN_LABEL_RE } from './chainNumber';
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
