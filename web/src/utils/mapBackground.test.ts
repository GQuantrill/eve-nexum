import { describe, it, expect } from 'vitest';
import { bgImageStyle } from './mapBackground';

describe('bgImageStyle', () => {
  it('draws nothing without a picture', () => {
    expect(bgImageStyle({ url: null, fit: 'cover', dim: 60 }, '#000000')).toBeNull();
  });
  it('veils the picture with the background colour at the darken amount', () => {
    const s = bgImageStyle({ url: 'data:image/webp;base64,AA', fit: 'contain', dim: 40 }, '#112233')!;
    expect(s.backgroundImage).toBe(
      'linear-gradient(color-mix(in srgb, #112233 40%, transparent), color-mix(in srgb, #112233 40%, transparent)), url("data:image/webp;base64,AA")');
    expect(s.backgroundSize).toBe('auto, contain');
    expect(s.backgroundRepeat).toBe('no-repeat');
  });
  it('tiles at the picture\'s own size', () => {
    const s = bgImageStyle({ url: 'data:image/png;base64,AA', fit: 'tile', dim: 0 }, '#000000')!;
    expect(s.backgroundSize).toBe('auto, auto');
    expect(s.backgroundRepeat).toBe('repeat');
  });
});
