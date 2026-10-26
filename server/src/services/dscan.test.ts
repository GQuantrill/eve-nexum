import { describe, it, expect } from 'vitest';
import { parseDistanceKm, parseDscanLine, parsePaste, sectionFor, summarise, newScanId, SCAN_ID_RE } from './dscan.js';

describe('parseDistanceKm', () => {
  it('reads km in the locales the client prints', () => {
    expect(parseDistanceKm('1,234 km')).toBe(1234);
    expect(parseDistanceKm('1.234 km')).toBe(1234);
    expect(parseDistanceKm('1 234 km')).toBe(1234);
    expect(parseDistanceKm('1 234 km')).toBe(1234);
    expect(parseDistanceKm('12,345,678 km')).toBe(12_345_678);
    expect(parseDistanceKm('87 km')).toBe(87);
  });

  it('reads metres and AU', () => {
    expect(parseDistanceKm('2,500 m')).toBe(2.5);
    expect(parseDistanceKm('4.2 AU')).toBeCloseTo(4.2 * 149_597_870.7);
    expect(parseDistanceKm('4,2 AU')).toBeCloseTo(4.2 * 149_597_870.7);
  });

  it('gives null for the "-" the client shows when it has no figure', () => {
    expect(parseDistanceKm('-')).toBeNull();
    expect(parseDistanceKm('')).toBeNull();
    expect(parseDistanceKm('far away')).toBeNull();
  });
});

describe('parseDscanLine', () => {
  it('reads the four tab-separated columns', () => {
    expect(parseDscanLine("29984\tBob's Tengu\tTengu\t1,234 km")).toEqual({
      typeId: 29984, name: "Bob's Tengu", typeName: 'Tengu', distanceKm: 1234,
    });
  });

  it('refuses a line without a numeric type id up front', () => {
    expect(parseDscanLine('Tengu\tBob\tTengu\t1 km')).toBeNull();
    expect(parseDscanLine('29984 Bob Tengu 1 km')).toBeNull();
    expect(parseDscanLine('0\tx\ty\t1 km')).toBeNull();
  });
});

describe('parsePaste', () => {
  const scan = [
    "29984\tBob's Tengu\tTengu\t1,234 km",
    '11567\tAvatar\tAvatar\t4.2 AU',
    '35832\tHome\tAstrahus\t-',
  ].join('\n');

  it('recognises a d-scan', () => {
    const p = parsePaste(scan);
    expect(p.kind).toBe('dscan');
    if (p.kind === 'dscan') expect(p.rows).toHaveLength(3);
  });

  it('copes with CRLF and a stray non-scan line', () => {
    const p = parsePaste(`${scan.replace(/\n/g, '\r\n')}\r\nsome header`);
    expect(p.kind).toBe('dscan');
  });

  it('recognises a local list and drops repeats', () => {
    const p = parsePaste('Bob Pilot\nAlice\nbob pilot\nO\'Neil-Smith Jr.\n');
    expect(p).toEqual({ kind: 'local', names: ['Bob Pilot', 'Alice', "O'Neil-Smith Jr."] });
  });

  it('refuses something that is neither', () => {
    expect(parsePaste('<script>alert(1)</script>')).toEqual({ kind: 'error', error: 'unrecognised' });
    expect(parsePaste('ab')).toEqual({ kind: 'error', error: 'unrecognised' });
    expect(parsePaste('  \n \n')).toEqual({ kind: 'error', error: 'empty' });
  });

  it('refuses an oversized scan', () => {
    const big = Array.from({ length: 5001 }, () => '29984\tx\tTengu\t1 km').join('\n');
    expect(parsePaste(big)).toEqual({ kind: 'error', error: 'too_many' });
  });
});

describe('sections and summary', () => {
  it('sorts categories into the breakdown sections', () => {
    expect(sectionFor(6)).toBe('ship');
    expect(sectionFor(65)).toBe('structure');
    expect(sectionFor(23)).toBe('structure');
    expect(sectionFor(22)).toBe('deployable');
    expect(sectionFor(87)).toBe('drone');
    expect(sectionFor(2)).toBe('other');
    expect(sectionFor(null)).toBe('other');
  });

  it('counts ships apart from everything else', () => {
    expect(summarise({
      kind: 'dscan', onGridKm: 10_000,
      types: { 1: { n: 'Tengu', g: 'Strategic Cruiser', s: 'ship', m: 1 }, 2: { n: 'Moon', g: 'Moon', s: 'other', m: null } },
      rows: [[1, 'a', 1], [1, 'b', 2], [2, 'c', null]],
    })).toEqual({ kind: 'dscan', total: 3, ships: 2 });
  });
});

describe('scan ids', () => {
  it('are 16 url-safe characters and not repeated', () => {
    const ids = new Set(Array.from({ length: 200 }, newScanId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(SCAN_ID_RE);
  });
});
