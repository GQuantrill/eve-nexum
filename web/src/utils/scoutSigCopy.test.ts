import { describe, it, expect } from 'vitest';
import { sigWritesFor, allSigWrites, sigKey, scoutSizeToConnSize, scoutTimeStatus,
         connWriteFor, allConnWrites, pairKey, endTypes } from './scoutSigCopy';
import type { ScoutLike, MappedSystem } from './scoutSigCopy';

const conn = (over: Partial<ScoutLike> = {}): ScoutLike => ({
  id: 'sc-1', whType: 'C729', maxShipSize: 'medium', remainingHours: 16,
  inSystemId: 30000142, inSystemName: 'Jita',
  inSignature: 'ABC-123', outSignature: 'XYZ-789', whExitsOutward: false, ...over,
});
const sys = (id: string, name: string, eveSystemId: number | null): MappedSystem =>
  ({ id, name, eveSystemId });

describe('sigWritesFor', () => {
  it('writes the far end when that system is on the map', () => {
    const w = sigWritesFor(conn(), [sys('s1', 'Jita', 30000142)], 'Thera');
    expect(w).toEqual([{ systemId: 's1', systemName: 'Jita', sigId: 'ABC-123',
                         whType: 'C729', whLeadsTo: 'Thera', timeStatus: 'lessThan24h',
                         scoutId: 'sc-1' }]);
  });

  it('writes the hub end too when the hub is mapped, pointing back', () => {
    // K162, not C729: this hole spawned at the far end, so the hub side is the
    // one you arrive at. Stamping C729 here would say Thera spawned it.
    const w = sigWritesFor(conn(), [sys('h', 'Thera', 31000005)], 'Thera');
    expect(w).toEqual([{ systemId: 'h', systemName: 'Thera', sigId: 'XYZ-789',
                         whType: 'K162', whLeadsTo: 'Jita', timeStatus: 'lessThan24h',
                         scoutId: 'sc-1' }]);
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

  // A wormhole carries its code at ONE end and K162 at the other. eve-scout's
  // listing shows the code for both, which is the right thing to read but the
  // wrong thing to copy: it would claim each side spawned the hole.
  it('puts the code on the far end and K162 at the hub for an inbound hole', () => {
    const both = [sys('s1', 'Jita', 30000142), sys('h', 'Thera', 31000005)];
    const w = sigWritesFor(conn({ whExitsOutward: false }), both, 'Thera');
    expect(w.map((x) => [x.systemName, x.whType])).toEqual([['Jita', 'C729'], ['Thera', 'K162']]);
  });

  it('puts the code at the hub and K162 on the far end for an outbound hole', () => {
    const both = [sys('s1', 'Jita', 30000142), sys('h', 'Thera', 31000005)];
    const w = sigWritesFor(conn({ whExitsOutward: true }), both, 'Thera');
    expect(w.map((x) => [x.systemName, x.whType])).toEqual([['Jita', 'K162'], ['Thera', 'C729']]);
  });

  it('points each end at the other whichever way the hole runs', () => {
    // Direction decides the CODE, never the destination: both ends still lead
    // to the system at the other end.
    const both = [sys('s1', 'Jita', 30000142), sys('h', 'Thera', 31000005)];
    for (const outward of [true, false]) {
      const w = sigWritesFor(conn({ whExitsOutward: outward }), both, 'Thera');
      expect(w.map((x) => x.whLeadsTo)).toEqual(['Thera', 'Jita']);
    }
  });
});

describe('endTypes', () => {
  // For Thera the code alone would be enough -- the types that lead there lead
  // ONLY there. Turnur is an ordinary low-sec system, so a low-to-low type
  // like N944 is listed in both directions and the code cannot tell you which
  // end is which. The feed's own flag is the only thing that can.
  it('reads the same code in both directions off the feed flag', () => {
    expect(endTypes({ whType: 'N944', whExitsOutward: true }))
      .toEqual({ hub: 'N944', far: 'K162' });
    expect(endTypes({ whType: 'N944', whExitsOutward: false }))
      .toEqual({ hub: 'K162', far: 'N944' });
  });

  it('never puts the code on both ends', () => {
    for (const outward of [true, false]) {
      const { hub, far } = endTypes({ whType: 'C729', whExitsOutward: outward });
      expect([hub, far].filter((c) => c === 'K162')).toHaveLength(1);
      expect([hub, far].filter((c) => c === 'C729')).toHaveLength(1);
    }
  });
});

describe('allSigWrites', () => {
  const systems = [sys('s1', 'Jita', 30000142)];

  it('still lists a signature that is already on the map', () => {
    // Copying is an upsert: the row may have been deleted by accident, or the
    // hole's remaining life may have moved on since it was first copied.
    // Filtering it out here would silence the button in exactly those cases.
    expect(allSigWrites([conn()], systems, 'Thera')).toHaveLength(1);
  });

  it('does not list the same signature twice within one batch', () => {
    expect(allSigWrites([conn(), conn()], systems, 'Thera')).toHaveLength(1);
  });

  it('lists every mapped connection', () => {
    const two = [conn(), conn({ inSignature: 'DEF-456' })];
    expect(allSigWrites(two, systems, 'Thera').map((w) => w.sigId)).toEqual(['ABC-123', 'DEF-456']);
  });

  it('lists nothing when no end is on the map', () => {
    expect(allSigWrites([conn()], [sys('x', 'Amarr', 30002187)], 'Thera')).toEqual([]);
  });

  it('carries the current life state, so a repeat copy refreshes it', () => {
    const [w] = allSigWrites([conn({ remainingHours: 0.5 })], systems, 'Thera');
    expect(w.timeStatus).toBe('lessThan1h');
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

describe('sigKey', () => {
  // This is what matches a feed row against one already on the map, so it
  // decides whether a copy updates an existing row or duplicates it. Scanner
  // ids arrive with stray case and whitespace from pastes and hand entry.
  it('matches the same signature however it was typed', () => {
    expect(sigKey('s1', ' abc-123 ')).toBe(sigKey('s1', 'ABC-123'));
  });

  it('keeps signatures in different systems apart', () => {
    // The same scanner id in two systems is ordinary; they must not collide.
    expect(sigKey('s1', 'ABC-123')).not.toBe(sigKey('s2', 'ABC-123'));
  });
});

describe('connWriteFor', () => {
  const far = sys('s1', 'Jita', 30000142);
  const hub = sys('h', 'Thera', 31000005);

  it('describes the hole when both ends are mapped', () => {
    expect(connWriteFor(conn(), [far, hub], 'Thera')).toEqual({
      fromId: 's1', toId: 'h', scoutId: 'sc-1',
      whType: 'C729', size: 'medium', timeStatus: 'lessThan24h',
    });
  });

  it('returns nothing when only one end is mapped', () => {
    // Drawing a hole would mean adding the other system to someone's map as a
    // side effect of copying signatures.
    expect(connWriteFor(conn(), [far], 'Thera')).toBeNull();
    expect(connWriteFor(conn(), [hub], 'Thera')).toBeNull();
  });

  it('labels the hole with its real code whichever end spawned it', () => {
    // The K162 belongs on a signature row, not on the connection: the map
    // labels the link with the type that identifies the hole.
    expect(connWriteFor(conn({ whExitsOutward: true }), [far, hub], 'Thera')?.whType).toBe('C729');
    expect(connWriteFor(conn({ whExitsOutward: false }), [far, hub], 'Thera')?.whType).toBe('C729');
  });

  it('takes size from the feed, which reports it directly', () => {
    expect(connWriteFor(conn({ maxShipSize: 'xlarge' }), [far, hub], 'Thera')?.size).toBe('xl');
    expect(connWriteFor(conn({ maxShipSize: 'frigate' }), [far, hub], 'Thera')?.size).toBeNull();
  });
});

describe('allConnWrites', () => {
  const systems = [sys('s1', 'Jita', 30000142), sys('h', 'Thera', 31000005)];

  it('does not describe the same pair twice', () => {
    expect(allConnWrites([conn(), conn()], systems, 'Thera')).toHaveLength(1);
  });

  it('pairKey ignores the order the two systems are given in', () => {
    expect(pairKey('a', 'b')).toBe(pairKey('b', 'a'));
  });
});
