import { describe, it, expect } from 'vitest';
import { isValidPreset, FLAG_COLOR_RE, FLAG_ICON_MAX, FLAG_NAME_MAX } from './useFlagPresets';

const GOOD = { id: 'p1', name: 'DO NOT ROLL', icon: 'SkullIcon', color: '#e05a5a' };

// These bounds are not cosmetic: the connection PATCH enforces the same ones,
// so a preset that fails them would save and then be rejected on every apply.
describe('flag preset validation', () => {
  it('accepts a well-formed preset', () => {
    expect(isValidPreset(GOOD)).toBe(true);
  });

  it('rejects a colour the edge could not safely render', () => {
    expect(isValidPreset({ ...GOOD, color: 'red' })).toBe(false);
    expect(isValidPreset({ ...GOOD, color: '#fff' })).toBe(false);
    // The edge drops this straight into a CSS custom property.
    expect(isValidPreset({ ...GOOD, color: '#ffffff;background:url(x)' })).toBe(false);
  });

  it('requires an icon, and bounds its length', () => {
    expect(isValidPreset({ ...GOOD, icon: '' })).toBe(false);
    expect(isValidPreset({ ...GOOD, icon: 'x'.repeat(FLAG_ICON_MAX) })).toBe(true);
    expect(isValidPreset({ ...GOOD, icon: 'x'.repeat(FLAG_ICON_MAX + 1) })).toBe(false);
  });

  it('bounds the name at the length flagNote allows', () => {
    expect(isValidPreset({ ...GOOD, name: 'x'.repeat(FLAG_NAME_MAX) })).toBe(true);
    expect(isValidPreset({ ...GOOD, name: 'x'.repeat(FLAG_NAME_MAX + 1) })).toBe(false);
  });

  it('rejects junk rather than trusting the stored shape', () => {
    // The list comes from ui_settings JSONB, which an older client may have
    // written differently — one bad entry must not take out the panel.
    for (const bad of [null, undefined, 'nope', 42, {}, { ...GOOD, id: 1 }, { ...GOOD, name: null }]) {
      expect(isValidPreset(bad)).toBe(false);
    }
  });

  it('the colour pattern matches what the server enforces', () => {
    expect(FLAG_COLOR_RE.source).toBe('^#[0-9a-fA-F]{6}$');
  });
});
