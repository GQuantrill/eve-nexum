import { describe, it, expect } from 'vitest';
import { sigWritesFor, pendingSigWrites, sigKey, scoutSizeToConnSize, scoutTimeStatus } from './scoutSigCopy';
import type { ScoutLike, MappedSystem } from './scoutSigCopy';

const conn = (over: Partial<ScoutLike> = {}): ScoutLike => ({
  whType: 'C729', maxShipSize: 'medium', remainingHours: 16,
  inSystemId: 30000142, inSystemName: 'Jita',
  inSignature: 'ABC-123', outSignature: 'XYZ-789', ...over,
});
const sys = (id: string, name: string, eveSystemId: number | null): MappedSystem =>
  ({ id, name, eveSystemId });

describe('sigWritesFor', () => {
  it('writes the far end when that system is on the map', () => {
    const w = sigWritesFor(conn(), [sys('s1', 'Jita', 30000142)], 'Thera');
    expect(w).toEqual([{ systemId: 's1', systemName: 'Jita', sigId: 'ABC-123',
                         whType: 'C729', whLeadsTo: 'Thera', timeStatus: 'lessThan24h' }]);
  });

  it('writes the hub end too when the hub is mapped, pointing back', () => {
    const w = sigWritesFor(conn(), [sys('h', 'Thera', 31000005)], 'Thera');
    expect(w).toEqual([{ systemId: 'h', systemName: 'Thera', sigId: 'XYZ-789',
                         whType: 'C729', whLeadsTo: 'Jita', timeStatus: 'lessThan24h' }]);
  });

  it('writes both ends when both are mapped', () => {
    const w = sigWritesFor(conn(), [sys('s1','Jita',30000142), sys('h','Thera',31000005)], 'Thera');
    expect(w.map((x) => x.systemId)).toEqual(['s1', 'h']);
  });

  it('writes nothing when neither end is on the map', () => {
    expect(sigWritesFor(conn(), [sys('x', 'Amarr', 30002187)], 'Thera')).toEqual([]);
  });

  it('skips an end whose signature id the feed does not know', () => {
    // Half-scanned holes come through with one side blank; a row with no id is
    // worse than no row.
    expect(sigWritesFor(conn({ inSignature: null }), [sys('s1','Jita',30000142)], 'Thera')).toEqual([]);
    expect(sigWritesFor(conn({ outSignature: '' }), [sys('h','Thera',31000005)], 'Thera')).toEqual([]);
  });

  it('matches the hub by name regardless of case', () => {
    expect(sigWritesFor(conn(), [sys('h', 'thera', 31000005)], 'Thera')).toHaveLength(1);
  });
});

describe('pendingSigWrites', () => {
  const systems = [sys('s1', 'Jita', 30000142)];

  it('leaves alone a signature already on the map', () => {
    const have = [sigKey('s1', 'ABC-123')];
    expect(pendingSigWrites([conn()], systems, 'Thera', have)).toEqual([]);
  });

  it('matches existing ids case- and space-insensitively', () => {
    expect(pendingSigWrites([conn()], systems, 'Thera', [sigKey('s1', ' abc-123 ')])).toEqual([]);
  });

  it('does not write the same signature twice within one batch', () => {
    const dup = [conn(), conn()];
    expect(pendingSigWrites(dup, systems, 'Thera', [])).toHaveLength(1);
  });

  it('returns what is genuinely missing', () => {
    const two = [conn(), conn({ inSignature: 'DEF-456' })];
    const w = pendingSigWrites(two, systems, 'Thera', [sigKey('s1', 'ABC-123')]);
    expect(w.map((x) => x.sigId)).toEqual(['DEF-456']);
  });
});

describe('scoutSizeToConnSize', () => {
  it('maps the feed vocabulary onto ours', () => {
    expect(scoutSizeToConnSize('xlarge')).toBe('xl');
    expect(scoutSizeToConnSize('MEDIUM')).toBe('medium');
    expect(scoutSizeToConnSize('frigate')).toBeNull();
  });
});

describe('scoutTimeStatus', () => {
  it('maps the feed\'s remaining hours onto the life buckets', () => {
    expect(scoutTimeStatus(30)).toBe('fresh');
    expect(scoutTimeStatus(16)).toBe('lessThan24h');
    expect(scoutTimeStatus(3)).toBe('lessThan4h');
    expect(scoutTimeStatus(0.5)).toBe('lessThan1h');
    expect(scoutTimeStatus(0)).toBe('expired');
  });

  it('asserts nothing when the feed has no lifetime', () => {
    // Better an unset field than a state nobody observed.
    expect(scoutTimeStatus(null)).toBe('');
    expect(scoutTimeStatus(undefined)).toBe('');
    expect(scoutTimeStatus(NaN)).toBe('');
  });
});
