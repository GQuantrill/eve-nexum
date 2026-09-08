import { describe, it, expect } from 'vitest';
import { truesecColor } from './truesec';

// Regression cover for the security colours. Two bugs lived here:
//
//   1. The band came from the RAW security while the number on screen came from
//      `toFixed(1)`, so two systems both displaying "0.4" could take different
//      colours. About one system in ten was affected.
//   2. There was no 0.2 band at all, so every 0.2 system borrowed 0.1's colour.
describe('truesecColor', () => {
  // The pair from the original report.
  it('gives two systems that DISPLAY the same security the same colour', () => {
    const mara   = 0.4200;   // displays 0.4
    const ishkad = 0.3660;   // displays 0.4 as well, but used to band as 0.3
    expect(mara.toFixed(1)).toBe(ishkad.toFixed(1));
    expect(truesecColor(ishkad)).toBe(truesecColor(mara));
  });

  // One real system per band that rounds UP across a boundary. Each of these
  // was previously coloured as the band below the one it displays.
  it.each([
    ['Adallier',    0.8503, '0.9', 'var(--cv-sec-09)'],
    ['Abaim',       0.7501, '0.8', 'var(--cv-sec-08)'],
    ['Aakari',      0.6501, '0.7', 'var(--cv-sec-07)'],
    ['Abhan',       0.5502, '0.6', 'var(--cv-sec-06)'],
    ['Adrallezoen', 0.4502, '0.5', 'var(--cv-sec-05)'],
    ['Adeel',       0.3514, '0.4', 'var(--cv-sec-04)'],
    ['Abune',       0.2505, '0.3', 'var(--cv-sec-03)'],
    ['Agaullores',  0.0569, '0.1', 'var(--cv-sec-01)'],
  ])('colours %s (%f) by the %s it displays', (_name, sec, shown, token) => {
    expect((sec as number).toFixed(1)).toBe(shown);
    expect(truesecColor(sec as number)).toBe(token);
  });

  it('gives 0.2 a band of its own rather than sharing 0.1', () => {
    expect(truesecColor(0.2)).toBe('var(--cv-sec-02)');
    expect(truesecColor(0.2)).not.toBe(truesecColor(0.1));
  });

  // Below 0.1 the RAW sign still decides, deliberately: a system with a sliver
  // of positive security is 0.0 space, not negative space.
  it('separates a sliver of positive security from true negative space', () => {
    expect(truesecColor(0.001)).toBe('var(--cv-sec-00)');
    expect(truesecColor(0)).toBe('var(--cv-sec-neg)');
    expect(truesecColor(-0.19)).toBe('var(--cv-sec-neg)');
  });

  it('never returns a bare colour, only a themeable custom property', () => {
    for (let s = -1; s <= 1.0001; s += 0.017) {
      expect(truesecColor(s)).toMatch(/^var\(--cv-sec-[0-9a-z]+\)$/);
    }
  });
});
