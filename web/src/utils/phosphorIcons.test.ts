import { describe, it, expect, beforeAll } from 'vitest';
import { iconComponent, usePhosphorStore } from './phosphorIcons';

// The real module, loaded the way the app loads it. Resolution is the whole
// point here, so stubbing it would test nothing.
beforeAll(async () => {
  usePhosphorStore.getState().ensureLoaded();
  // ensureLoaded is fire-and-forget; wait for the store to flip.
  for (let i = 0; i < 200 && !usePhosphorStore.getState().loaded; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(usePhosphorStore.getState().loaded).toBe(true);
});

describe('iconComponent', () => {
  it('resolves the base name the picker stores', () => {
    expect(iconComponent('Tag')).toBeTruthy();
    expect(iconComponent('Skull')).toBeTruthy();
  });

  it('also resolves a name that already carries the Icon suffix', () => {
    // Saved presets exist in this form. Before, this produced 'TagIconIcon'
    // and rendered an empty button -- an icon control you could not see.
    expect(iconComponent('TagIcon')).toBeTruthy();
    expect(iconComponent('TagIcon')).toBe(iconComponent('Tag'));
  });

  it('returns null for a name that is genuinely not an icon', () => {
    expect(iconComponent('DefinitelyNotAnIcon')).toBeNull();
    expect(iconComponent('')).toBeNull();
  });

  it('lists names in the base form, so the picker and resolver agree', () => {
    const { names } = usePhosphorStore.getState();
    expect(names).toContain('Tag');
    expect(names).not.toContain('TagIcon');
    for (const n of names.slice(0, 50)) expect(iconComponent(n)).toBeTruthy();
  });
});
