import { describe, it, expect } from 'vitest';
import { sanitiseWatched, summarise, heatBySystem, sightsBySystem, type Sighting } from './pilotWatch';
import { namesPilot } from '../desktop/intel';

const row = (characterId: number, eveSystemId: number, seenAt: string): Sighting => ({
  characterId, name: `P${characterId}`, corpId: null, allianceId: null,
  eveSystemId, systemName: `S${eveSystemId}`, mapId: 'm', source: 'local', seenAt,
});

describe('pilot watch', () => {
  it('keeps only well-formed, distinct watch entries', () => {
    expect(sanitiseWatched([{ id: 1, name: 'A' }, { id: 1, name: 'A again' }, { id: -2, name: 'B' }, 'x', { id: 3 }]))
      .toEqual([{ id: 1, name: 'A' }]);
    expect(sanitiseWatched('nope')).toEqual([]);
  });

  it('sums sightings per pilot, newest first', () => {
    const rows = [row(1, 10, '2026-11-27T12:00:00Z'), row(1, 11, '2026-11-27T11:00:00Z'), row(1, 10, '2026-11-27T10:00:00Z'), row(2, 10, '2026-11-27T09:00:00Z')];
    const s = summarise(rows);
    expect(s.get(1)).toMatchObject({ count: 3, systems: 2, last: { eveSystemId: 10, seenAt: '2026-11-27T12:00:00Z' } });
    expect(s.get(2)?.count).toBe(1);
    expect([...heatBySystem(rows, 1)]).toEqual([[10, 2], [11, 1]]);
  });

  it('finds a pilot named in an intel line as whole words', () => {
    expect(namesPilot('Jita  Bob Pilot  Other Guy +2', 'bob pilot')).toBe(true);
    expect(namesPilot('Jita Bobby Pilots', 'Bob Pilot')).toBe(false);
    expect(namesPilot("Amarr Mr. O'Neil nv", "Mr. O'Neil")).toBe(true);
  });
});

describe('sighting markers', () => {
  it('lists each watched pilot once per system, newest first', () => {
    const rows = [row(1, 10, '2026-11-27T12:00:00Z'), row(2, 10, '2026-11-27T11:00:00Z'), row(1, 10, '2026-11-27T10:00:00Z'), row(3, 10, '2026-11-27T09:00:00Z')];
    const m = sightsBySystem(rows, new Set([1, 2]));
    expect(m.get(10)).toEqual([
      { name: 'P1', at: Date.parse('2026-11-27T12:00:00Z') },
      { name: 'P2', at: Date.parse('2026-11-27T11:00:00Z') },
    ]);
  });
});
