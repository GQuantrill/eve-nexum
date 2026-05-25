import { useUserSetting } from './useUserSetting';
import type { CustomIntel } from '../types';

const SETTING_KEY = 'nexum.customIntel';

/** Cap on user-defined intel options. Keeps the right-click submenu and
 *  sidebar list manageable; anything past this is a sign the user should
 *  be using map notes instead. */
export const MAX_CUSTOM_INTEL = 12;

export function useCustomIntel(): [CustomIntel[], (next: CustomIntel[] | ((prev: CustomIntel[]) => CustomIntel[])) => void] {
  const [value, setValue] = useUserSetting<CustomIntel[]>(SETTING_KEY, []);
  // Defensive read: the stored value comes from ui_settings JSONB and could
  // be malformed if a different client version wrote a different shape.
  // Filter out anything that doesn't look like a valid entry.
  const safe = Array.isArray(value)
    ? value.filter((v): v is CustomIntel =>
        v != null
        && typeof v === 'object'
        && typeof (v as CustomIntel).id === 'string'
        && typeof (v as CustomIntel).label === 'string'
        && typeof (v as CustomIntel).color === 'string')
    : [];
  return [safe, setValue];
}
