import { describe, it, expect } from 'vitest';
import { linkEndSigs, shortSigId } from './linkSigIds';
import type { WhSig } from './undivedWormholes';

const systems = new Map([['a', { name: 'J103353' }], ['b', { name: 'J120246' }]]);
const sig = (id: string, sigId: string, leadsTo = ''): WhSig => ({ id, sigId, whType: 'N770', leadsTo });
const conn = (src: string | null = null, tgt: string | null = null) =>
  ({ sourceId: 'a', targetId: 'b', sourceSignatureId: src, targetSignatureId: tgt });

describe('linkEndSigs', () => {
  it('uses the backing sig on each end', () => {
    const sigs = { a: [sig('s1', 'MDR-044')], b: [sig('s2', 'XYZ-123')] };
    expect(linkEndSigs(conn('s1', 's2'), systems, sigs)).toEqual({ source: 'MDR-044', target: 'XYZ-123' });
  });

  it('falls back to the one sig pinned to the far system by name', () => {
    const sigs = { a: [sig('s1', 'MDR-044', 'j120246'), sig('s3', 'QQQ-111', 'C5')] };
    expect(linkEndSigs(conn(), systems, sigs)).toEqual({ source: 'MDR-044', target: null });
  });

  it('shows nothing when two sigs are pinned to the same system', () => {
    const sigs = { a: [sig('s1', 'MDR-044', 'J120246'), sig('s3', 'QQQ-111', 'J120246')] };
    expect(linkEndSigs(conn(), systems, sigs).source).toBeNull();
  });

  it('does not guess from a class-only leads-to', () => {
    const sigs = { a: [sig('s1', 'MDR-044', 'C5')] };
    expect(linkEndSigs(conn(), systems, sigs).source).toBeNull();
  });

  it('ignores a backing id whose sig is gone', () => {
    expect(linkEndSigs(conn('gone'), systems, {}).source).toBeNull();
  });
});

describe('shortSigId', () => {
  it('keeps the letters', () => {
    expect(shortSigId('MDR-044')).toBe('MDR');
    expect(shortSigId('mdr')).toBe('MDR');
  });
});
