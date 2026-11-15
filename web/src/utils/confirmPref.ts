const SKIP_KEY = 'nexum.skipDeleteConfirm';

/** Has the user ticked "don't ask again" on destructive confirmations? */
export function shouldSkipConfirm(): boolean {
  return localStorage.getItem(SKIP_KEY) === 'true';
}

export function setSkipConfirm(skip: boolean): void {
  if (skip) localStorage.setItem(SKIP_KEY, 'true');
  else localStorage.removeItem(SKIP_KEY);
}

/** Ask before Delete / Backspace removes systems from the map. Synced setting
 *  (useUserSetting), separate from the shared skip above: a stray key is the
 *  accident this guards against, so an earlier "don't ask again" on another
 *  confirm doesn't switch it off. */
export const CONFIRM_KEY_DELETE_KEY = 'nexum.map.confirmKeyDelete';
