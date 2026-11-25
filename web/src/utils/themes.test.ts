import { describe, it, expect } from 'vitest';
import { parseCustomThemes, resolveTheme, normaliseTheme, luminance, MAX_BG_LUMINANCE, MAX_CUSTOM_THEMES } from './themes';

const seeds = { primary: '#112233', highlight: '#445566', bg: '#000000', accent: '#ff8800' };

describe('custom themes', () => {
  it('keeps only well-formed themes, once each, up to the cap', () => {
    const list = parseCustomThemes([
      { id: 'a', name: 'Mine', seeds },
      { id: 'a', name: 'Dupe', seeds },
      { id: 'BAD ID', name: 'x', seeds },
      { id: 'b', name: 'Bad colour', seeds: { ...seeds, bg: 'red' } },
      { id: 'c', name: 42, seeds },
      'junk',
    ]);
    expect(list.map((t) => t.id)).toEqual(['a', 'c']);
    expect(list[1].name).toBe('');
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: '', seeds }));
    expect(parseCustomThemes(many)).toHaveLength(MAX_CUSTOM_THEMES);
    expect(parseCustomThemes(null)).toEqual([]);
  });

  it('resolves a preset, a custom theme, or falls back to the default', () => {
    const customs = parseCustomThemes([{ id: 'a', name: 'Mine', seeds }]);
    expect(resolveTheme('amarr', customs)).toEqual({ kind: 'preset', id: 'amarr' });
    expect(resolveTheme('custom:a', customs)).toMatchObject({ kind: 'custom', theme: { id: 'a' } });
    expect(normaliseTheme('custom:gone', customs)).toBe('nexum');
    expect(normaliseTheme('nonsense', customs)).toBe('nexum');
  });

  it('only lets a dark background through', () => {
    expect(luminance('#0a0e1a')).toBeLessThan(MAX_BG_LUMINANCE);
    expect(luminance('#808080')).toBeGreaterThan(MAX_BG_LUMINANCE);
  });
});
