import { describe, it, expect } from 'vitest';
import { classifyAnom, parseAnomClipboard } from './anomParse';

// A probe-scanner row: id, group, type, name, signal, distance.
const row = (id: string, type: string, name: string) =>
  `${id}\tCosmic Anomaly\t${type}\t${name}\t100.0%\t1.02 AU`;

describe('anomaly classification', () => {
  it.each([
    ['combat site', 'Perimeter Ambush Point', 'combat'],
    ['ore site',    'Small Asteroid Cluster', 'ore'],
    ['homefront operations', 'Whatever',      'homefront'],
  ])('maps the scanner type "%s" to %s', (type, name, expected) => {
    expect(classifyAnom(type, name)).toBe(expected);
  });

  // The reported miss: these three arrive with a type column that doesn't
  // resolve, so they landed as Unknown. Matched on the site name instead.
  it.each([
    // The original operations
    'Salvage Research', 'Traffic Stop', 'Stabilize Rift',
    // The five-player operations added in 2023
    'Abyssal Attack', 'Dread Assault', 'Emergency Aid', 'Suspicious Signal',
  ])('classifies the homefront site "%s" even when the type column does not resolve', (name) => {
    expect(classifyAnom('', name)).toBe('homefront');
  });

  it('matches those names whatever the casing or padding', () => {
    expect(classifyAnom('', '  TRAFFIC STOP ')).toBe('homefront');
    expect(classifyAnom('', 'stabilize rift')).toBe('homefront');
  });

  // Tolerant of wording we haven't seen, so the next one CCP ships isn't a
  // silent Unknown just because the label changed.
  it.each(['homefront site', 'Homefront Operations', 'deadspace homefront thing'])(
    'treats any type containing "homefront" as homefront (%s)', (type) => {
      expect(classifyAnom(type.toLowerCase(), 'Unrecognised')).toBe('homefront');
    });

  it('still says unknown for something genuinely unrecognised', () => {
    expect(classifyAnom('', 'Some Site Nobody Has Mapped')).toBe('unknown');
    expect(classifyAnom('mystery type', '')).toBe('unknown');
  });
});

describe('parseAnomClipboard', () => {
  it('classifies the three homefront sites from a real paste', () => {
    const text = [
      row('AAA-111', '', 'Salvage Research'),
      row('BBB-222', '', 'Traffic Stop'),
      row('CCC-333', '', 'Stabilize Rift'),
      row('DDD-444', 'Combat Site', 'Perimeter Ambush Point'),
    ].join('\n');
    expect(parseAnomClipboard(text).map((a): [string, string] => [a.anomId, a.anomType])).toEqual([
      ['AAA-111', 'homefront'],
      ['BBB-222', 'homefront'],
      ['CCC-333', 'homefront'],
      ['DDD-444', 'combat'],
    ]);
  });

  // The pane split: signatures in the same paste belong to the other pane.
  it('ignores rows the scanner classes as signatures', () => {
    const text = [
      row('AAA-111', '', 'Traffic Stop'),
      'EEE-555\tCosmic Signature\tRelic Site\tRuined Sansha Monument\t100.0%\t2.0 AU',
    ].join('\n');
    const out = parseAnomClipboard(text);
    expect(out).toHaveLength(1);
    expect(out[0].anomId).toBe('AAA-111');
  });
});
