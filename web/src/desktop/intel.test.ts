import { describe, it, expect } from 'vitest';
import { systemsNamed } from './intel';

const map = [
  { id: 'a', name: '1DQ1-A' },
  { id: 'b', name: 'Jita' },
  { id: 'c', name: 'J123456' },
  { id: 'd', name: 'New Caldari' },
];

describe('systemsNamed', () => {
  it('finds full system names, any case', () => {
    expect(systemsNamed('Some Pilot  1DQ1-A', map)).toEqual(['a']);
    expect(systemsNamed('red in jita gate', map)).toEqual(['b']);
    expect(systemsNamed('J123456 + 5 hostiles', map)).toEqual(['c']);
    expect(systemsNamed('gang in New Caldari', map)).toEqual(['d']);
  });
  it('ignores short forms and names inside other words', () => {
    expect(systemsNamed('1dq hostile', map)).toEqual([]);
    expect(systemsNamed('1DQ1-AB', map)).toEqual([]);
    expect(systemsNamed('Jitas', map)).toEqual([]);
  });
  it('ignores clear reports', () => {
    expect(systemsNamed('1DQ1-A clr', map)).toEqual([]);
    expect(systemsNamed('Jita clear', map)).toEqual([]);
  });
});
