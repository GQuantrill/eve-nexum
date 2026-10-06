import { describe, it, expect } from 'vitest';
import { normaliseDensity, applyDensity, DEFAULT_DENSITY } from './density';

describe('normaliseDensity', () => {
  it('keeps the three known levels', () => {
    expect(normaliseDensity('comfortable')).toBe('comfortable');
    expect(normaliseDensity('compact')).toBe('compact');
    expect(normaliseDensity('dense')).toBe('dense');
  });

  it('falls back to the default for anything else', () => {
    // A level removed in a later release, or junk in a stale stored setting.
    for (const v of ['ultra', '', null, undefined, 2, {}]) {
      expect(normaliseDensity(v)).toBe(DEFAULT_DENSITY);
    }
  });
});

describe('applyDensity', () => {
  it('leaves no attribute at the default, so the plain :root rules apply', () => {
    const el = document.createElement('div');
    el.setAttribute('data-density', 'dense');
    applyDensity('comfortable', el);
    expect(el.hasAttribute('data-density')).toBe(false);
  });

  it('stamps the tighter levels', () => {
    const el = document.createElement('div');
    applyDensity('compact', el);
    expect(el.getAttribute('data-density')).toBe('compact');
    applyDensity('dense', el);
    expect(el.getAttribute('data-density')).toBe('dense');
  });
});
