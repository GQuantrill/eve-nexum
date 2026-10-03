import { useUserSetting } from './useUserSetting';
import type { FlagPreset } from '../types';

const SETTING_KEY = 'nexum.flagPresets';

/** Cap on personal flag presets. Matches MAX_CUSTOM_INTEL — past a dozen the
 *  point of a preset (pick it without thinking) is gone. */
export const MAX_FLAG_PRESETS = 12;

/** Bounds the connection PATCH enforces on the fields a preset writes. Kept
 *  here so the editor can refuse to save a preset that would be rejected on
 *  every apply rather than failing later, at the point of use. */
export const FLAG_ICON_MAX = 64;
export const FLAG_NAME_MAX = 200;
export const FLAG_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidPreset(v: unknown): v is FlagPreset {
  if (v == null || typeof v !== 'object') return false;
  const p = v as FlagPreset;
  return typeof p.id === 'string'
    && typeof p.name === 'string'  && p.name.length <= FLAG_NAME_MAX
    && typeof p.icon === 'string'  && p.icon.length > 0 && p.icon.length <= FLAG_ICON_MAX
    && typeof p.color === 'string' && FLAG_COLOR_RE.test(p.color);
}

export function useFlagPresets(): [FlagPreset[], (next: FlagPreset[] | ((prev: FlagPreset[]) => FlagPreset[])) => void] {
  const [value, setValue] = useUserSetting<FlagPreset[]>(SETTING_KEY, []);
  // Defensive read, same reasoning as useCustomIntel: the value comes from
  // ui_settings JSONB and a different client version could have written a
  // different shape. One malformed entry must not take out the whole panel.
  const safe = Array.isArray(value) ? value.filter(isValidPreset) : [];
  return [safe, setValue];
}
