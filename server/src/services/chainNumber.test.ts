import { describe, it, expect } from 'vitest';
import { childLabel, childIndex, labelParts, CHAIN_LABEL_RE } from './chainNumber.js';

describe('chain number labels', () => {
  it('appends a digit per hole, a dotted part past 9', () => {
    expect(childLabel('', 1)).toBe('1');
    expect(childLabel('5', 1)).toBe('51');
    expect(childLabel('516', 2)).toBe('5162');
    expect(childLabel('5', 10)).toBe('5.10');
    expect(childLabel('5.10', 1)).toBe('5.10.1');
    expect(childLabel('', 10)).toBe('.10');
  });

  it('reads them back without mixing up a tenth hole and a deeper one', () => {
    expect(labelParts('5162')).toEqual([5, 1, 6, 2]);
    expect(labelParts('5.10.1')).toEqual([5, 10, 1]);
    expect(labelParts('.10')).toEqual([10]);
    expect(childIndex('5', '51')).toBe(1);
    expect(childIndex('5', '5.10')).toBe(10);
    expect(childIndex('5', '511')).toBeNull();
    expect(childIndex('', '7')).toBe(7);
    expect(childIndex('', '71')).toBeNull();
    expect(childIndex('5.10', '5.10.2')).toBe(2);
  });

  it('accepts only well-formed labels by hand', () => {
    for (const ok of ['1', '5162', '5.10', '.10', '5.10.1']) expect(CHAIN_LABEL_RE.test(ok)).toBe(true);
    for (const bad of ['', '0', '50', 'a1', '5..1', '5.', '1 2', '=1']) expect(CHAIN_LABEL_RE.test(bad)).toBe(false);
  });
});
