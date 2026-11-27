import { describe, it, expect } from 'vitest';
import { intelNameCandidates } from './pilotWatch';

const isSystem = (w: string) => /^[A-Z0-9]{1,5}-[A-Z0-9]{1,5}$/i.test(w);

describe('intelNameCandidates', () => {
  const lines = [
    { sender: 'addelee', text: 'A-803L Jord4n Echo', at: 2 },
    { sender: 'Coreola', text: 'SantavHlamus Heron RR-D05, nv', at: 1 },
  ];

  it('offers the words around the typed text, never a system', () => {
    const names = intelNameCandidates(lines, 'jord', isSystem).map((c) => c.name);
    expect(names).toContain('Jord4n Echo');
    expect(names).toContain('Jord4n');
    expect(names.some((n) => n.includes('A-803L'))).toBe(false);
  });

  it('includes senders and strips punctuation', () => {
    expect(intelNameCandidates(lines, 'core', isSystem).map((c) => c.name)).toEqual(['Coreola']);
    const her = intelNameCandidates(lines, 'heron', isSystem).map((c) => c.name);
    expect(her).toContain('SantavHlamus Heron');
    expect(her.some((n) => n.includes(','))).toBe(false);
  });

  it('needs two letters', () => {
    expect(intelNameCandidates(lines, 'j', isSystem)).toEqual([]);
  });
});
